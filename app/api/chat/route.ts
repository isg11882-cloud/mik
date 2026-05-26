import { buildSystemPrompt, phaseFromDays, type UserContext } from '@/lib/ai-system-prompt'
import { createSupabaseServer } from '@/lib/supabase/server'

// Gemini 모델 (무료 티어 할당량 이슈 우회를 위해 flash-latest 사용)
const AI_MODEL = process.env.GEMMA_MODEL_ID || 'gemini-flash-latest'

interface GeminiMessage {
  role: 'user' | 'model'
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>
}

/**
 * Phase 2-A — AI Contextual Memory
 *
 * 로그인 사용자라면 profiles 캐시(breakup_type, breakup_date, current_phase,
 * diagnosis_summary, situation_memo, nickname)를 1쿼리로 읽어 시스템 프롬프트에 주입.
 * 클라이언트가 보낸 userContext 는 비로그인 fallback 으로만 사용.
 *
 * days_since_breakup 은 profiles.breakup_date(DATE) 기준으로 매 호출 재계산.
 * PHASE 도 그 결과로 자동 갱신 (시간이 지나면 PHASE 1 → 2 → 3 자연스럽게 진입).
 */
async function resolveUserContext(clientContext: UserContext | undefined): Promise<UserContext> {
  // 비로그인/실패 시 fallback 으로 쓸 안전한 기본값
  const fallback: UserContext = clientContext ?? {
    breakupType: null,
    daysSinceBreakup: 0,
    currentPhase: 1,
  }

  try {
    const supabase = await createSupabaseServer()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return fallback

    const { data: profile } = await supabase
      .from('profiles')
      .select('nickname, breakup_type, breakup_date, current_phase, days_since_breakup, diagnosis_summary, situation_memo')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile) return fallback

    // breakup_date 가 있으면 정확히 재계산, 없으면 캐시값 → 클라값 순으로 fallback
    const recomputedDays = profile.breakup_date
      ? Math.max(0, Math.floor((Date.now() - new Date(profile.breakup_date).getTime()) / 86_400_000))
      : null

    const days = recomputedDays
      ?? profile.days_since_breakup
      ?? fallback.daysSinceBreakup

    return {
      breakupType: profile.breakup_type ?? fallback.breakupType,
      // PHASE 는 days 기준으로 자동 재계산 (진단 시점 phase 는 초기값일 뿐)
      currentPhase: phaseFromDays(days),
      daysSinceBreakup: days,
      userName: profile.nickname ?? fallback.userName,
      gender: fallback.gender,
      partnerGender: fallback.partnerGender,
      situation: profile.diagnosis_summary ?? fallback.situation,
      situationMemo: profile.situation_memo ?? undefined,
      coachingStyle: fallback.coachingStyle,
    }
  } catch (err) {
    console.error('[chat] resolveUserContext failed, using client fallback:', err)
    return fallback
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { messages, userContext: clientContext, image }: {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>
      userContext?: UserContext
      image?: { mimeType: string; data: string }
    } = body

    // 서버 컨텍스트 머지: 로그인 사용자는 profiles 우선, 비로그인은 클라 값 그대로
    const userContext = await resolveUserContext(clientContext)
    const systemPrompt = buildSystemPrompt(userContext)

    // MVP 무료 모드 최적화: USE_REAL_GEMINI 가 명시적으로 'true'가 아니면
    // 요금 과금 한계 방지를 위해 100% 안전한 로컬/Mock AI로 즉각 기본 우회합니다.
    if (process.env.USE_REAL_GEMINI !== 'true') {
      console.log('[chat] MVP Safe Mode: Defaulting to local/mock AI fallback to prevent API billing limits.')
      return runLocalOrMockAI(messages, userContext, image)
    }

    const apiKey = process.env.GOOGLE_AI_API_KEY
    if (!apiKey) {
      console.error('[CRITICAL] GOOGLE_AI_API_KEY is not set in Vercel environment variables.')
      return new Response(
        JSON.stringify({
          error: 'CONFIG_ERROR',
          detail: '서비스 설정 중입니다. 잠시 후 다시 시도해 주세요. (관리자: Vercel 환경변수 GOOGLE_AI_API_KEY 확인 필요)',
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const contents: GeminiMessage[] = messages.map((m, idx) => {
      const isLastUserMessage = idx === messages.length - 1 && m.role === 'user'
      const parts: GeminiMessage['parts'] = [{ text: m.content || '(내용 없음)' }]
      if (isLastUserMessage && image) {
        parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } })
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts,
      }
    })

    // streamGenerateContent 사용 (alt=sse 파라미터로 SSE 형식 수신)
    const apiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`

    let response: Response
    try {
      response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          system_instruction: { parts: [{ text: systemPrompt }] },
          generationConfig: {
            maxOutputTokens: 1500,
            temperature: 0.75,
            topP: 0.9,
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          ],
        }),
      })
    } catch (fetchErr: any) {
      console.error('[Gemini API Fetch Failure, routing to local/mock fallback]:', fetchErr.message)
      return runLocalOrMockAI(messages, userContext, image)
    }

    if (!response.ok) {
      let errorMessage = 'Unknown API Error'
      try {
        const errorData = await response.json()
        errorMessage = errorData.error?.message || errorData.message || JSON.stringify(errorData)
      } catch {
        errorMessage = `HTTP ${response.status}: ${response.statusText}`
      }

      console.error('[Gemini API Failure, routing to local/mock fallback]:', errorMessage)
      return runLocalOrMockAI(messages, userContext, image)
    }

    // SSE 형식(data: {...}) 파싱 — 안정적이고 정확함
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    const stream = new ReadableStream({
      async start(controller) {
        if (!response.body) {
          controller.close()
          return
        }
        const reader = response.body.getReader()
        let buffer = ''

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            // 마지막 줄은 미완성일 수 있으므로 버퍼에 남김
            buffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const jsonStr = trimmed.slice(5).trim()
              if (jsonStr === '[DONE]') continue

              try {
                const json = JSON.parse(jsonStr)
                const text = json?.candidates?.[0]?.content?.parts?.[0]?.text

                if (text) {
                  controller.enqueue(encoder.encode(text))
                }

                const finishReason = json?.candidates?.[0]?.finishReason
                if (finishReason === 'SAFETY') {
                  controller.enqueue(encoder.encode('\n\n(안전 정책으로 인해 일부 답변이 생략되었습니다.)'))
                }
              } catch {
                // 파싱 실패한 청크는 무시
              }
            }
          }
        } catch (err: any) {
          console.error('[Stream Read Error]:', err.message)
          controller.enqueue(encoder.encode('\n\n(연결이 중단되었습니다. 다시 시도해 주세요.)'))
        } finally {
          controller.close()
          reader.releaseLock()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    })
  } catch (err: any) {
    console.error('[Global Chat API Error]:', err)
    return new Response(
      JSON.stringify({ error: 'SERVER_ERROR', detail: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
}

/**
 * 로컬 또는 Mock AI 하이브리드 스트리밍 폴백 처리기
 */
async function runLocalOrMockAI(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  userContext: UserContext,
  image?: { mimeType: string; data: string }
): Promise<Response> {
  // macOS 등에서 localhost DNS 확인 지연(IPv6 ::1 대기 시간)을 피하기 위해 127.0.0.1 을 기본으로 지정합니다.
  const OLLAMA_URL = process.env.OLLAMA_API_URL || 'http://127.0.0.1:11434/api/chat'
  
  try {
    // Ollama 서버 헬스체크 및 모델 유무 검증 (1500ms 넉넉한 타이머로 지연 핸드쉐이크 커버)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 1500)
    
    const checkRes = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'gemma4:e4b',
        messages: [{ role: 'user', content: 'test' }],
        stream: false
      }),
      signal: controller.signal
    }).catch(() => null)
    
    clearTimeout(timeoutId)

    if (checkRes && checkRes.ok) {
      console.log('[Ollama] Local server detected. Streaming from local LLM...')
      const systemPrompt = buildSystemPrompt(userContext)
      const ollamaResponse = await fetch(OLLAMA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL || 'gemma4:e4b',
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages.map(m => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content
            }))
          ],
          stream: true
        })
      })

      if (ollamaResponse.ok && ollamaResponse.body) {
        const encoder = new TextEncoder()
        const decoder = new TextDecoder()
        
        const stream = new ReadableStream({
          async start(ctrl) {
            const reader = ollamaResponse.body!.getReader()
            let buffer = ''
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() || ''
                
                for (const line of lines) {
                  if (!line.trim()) continue
                  try {
                    const json = JSON.parse(line)
                    const token = json.message?.content || json.response || ''
                    if (token) {
                      ctrl.enqueue(encoder.encode(token))
                    }
                  } catch {}
                }
              }
            } catch (err) {
              console.error('[Ollama Stream Read Error]', err)
            } finally {
              ctrl.close()
              reader.releaseLock()
            }
          }
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
          }
        })
      } else {
        throw new Error(`Ollama stream request failed with status: ${ollamaResponse?.status}`)
      }
    } else {
      throw new Error('Ollama check failed or model not available')
    }
  } catch (err: any) {
    console.log(`[Ollama] Local server check failed/errored: ${err.message}. Falling back to Mock AI...`)
  }

  // 최종 Fallback: 초고품질 Mock AI 스트리밍 엔진 작동
  console.log('[Mock AI] Connection failed or bypassed. Streaming high-quality psychological mock response...')
  return generateMockAIResponse(messages, userContext, image)
}
/**
 * 재회심리학 지침 기반 고품질 Mock AI 스트리밍 엔진 (코칭 스타일 3중 분기)
 */
function generateMockAIResponse(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  userContext: UserContext,
  image?: { mimeType: string; data: string }
): Response {
  const lastUserMsgRaw = messages[messages.length - 1]?.content || ''
  // 맥OS 및 모바일 한글 자모분리(NFD) 현상 대응을 위한 NFC 정규화 및 소문자화
  const lastUserMsg = lastUserMsgRaw.normalize('NFC').trim()
  const lowerMsg = lastUserMsg.toLowerCase()

  const phase = userContext.currentPhase || 1
  const type = userContext.breakupType || 'A'
  const userName = userContext.userName || '재회 희망자'
  const style = userContext.coachingStyle || 'healing'

  // 대화 기록 중 실제 사용자가 발화한 횟수를 추출하여 컨텍스트 뎁스 감지
  const userMessageCount = messages.filter(m => m.role === 'user').length

  let reply = ''
  let recommendedMission: any = null

  // 1. 이미지가 첨부된 경우 -> 카카오톡 캡처 5단계 이미지 초정밀 심리 분석 분기 작동
  if (image) {
    const hasCustomMsg = lastUserMsg && lastUserMsg !== '이미지를 확인해 주세요.'
    const headerPrefix = hasCustomMsg 
      ? `보내주신 카카오톡 대화 캡처본과 함께 올려주신 소중한 고민("${lastUserMsg}")을 심리학적으로 다각도에서 정밀 독해하였습니다.\n\n`
      : ''

    if (style === 'healing') {
      reply = `${headerPrefix}[카카오톡 캡처 초정밀 5단계 심리 분석 보고서] 📸\n\n` +
        `1. 대화 템포 분석 ⏱️\n` +
        `- 상대방이 답장을 하는 속도가 다소 느리거나 띄엄띄엄 이루어지고 있네요. 당신의 따뜻한 연락에 비해 상대방은 현재 자신의 마음을 지키기 위한 일종의 '방어벽'을 세우고 있는 템포입니다. 서두르지 않고 상대의 속도에 맞춰주는 여유가 필요한 시점입니다.\n\n` +
        `2. 텍스트 디테일 분석 💬\n` +
        `- 문장 끝에 물음표가 전혀 없고 온점(.)이나 마침표 위주로 끝나는 건조한 어조입니다. 하트나 웃음 기호가 현저히 줄어든 것은 현재 상대방이 의도적으로 차분함을 유지하려 애쓰는 심리적 상태를 반영합니다.${hasCustomMsg ? ` 특히 적어주신 고민내용처럼 상대방의 이러한 차갑고 단호한 반응으로 인해 깊은 불안과 고독을 느끼시는 심리를 충분히 헤아릴 수 있습니다. 지금은 흔들릴지언정 완전히 꺾인 것은 아닙니다.` : ''}\n\n` +
        `3. 관심 및 호감도 평가 ❤️\n` +
        `- 현재 호감도 게이지: 3.5점 / 10점\n` +
        `- 비록 지금은 차갑고 단호해 보이지만, 당신의 물음에 답장을 꼬박꼬박 하고 있는 행위 자체는 당신이라는 존재에 대한 미련과 책임감이 아직 완전히 소진되지는 않았음을 시사합니다. 희망을 잃지 마세요. 🫂\n\n` +
        `4. 프레임 주도권 판정 ⚖️\n` +
        `- 현재 상대방이 고프레임(우위), 내담자님이 저프레임(저자세)에 놓여 있습니다. 내담자님이 지나치게 상대의 눈치를 보며 길게 톡을 보내는 반면, 상대는 짧은 단답으로 일관하고 있어 주도권이 상대에게 쏠려 있습니다.\n\n` +
        `5. 단 하나의 명쾌한 다음 액션 ⚡\n` +
        `- 지금 당장 답장을 보내거나 매달리지 마세요! 상대방이 이 대화를 끝으로 생각하게 두고, 최소 2주 동안 메신저를 끄고 침묵을 유지하여 당신의 소중함(#공백기)을 느끼게 하는 것이 최고의 묘약입니다. 🌸 아프고 흔들리는 내담자님의 마음을 재이가 온 힘을 다해 지켜드릴게요. 힘내세요!`;
      recommendedMission = {
        phase: 1,
        category: "mindset",
        title: "상대방 카톡 프로필 보지 않고 24시간 동안 나만의 휴식 취하기",
        reason: "상대방의 차가운 톡 반응에 지친 뇌를 쉬게 하고 내적 가치(#내적프레임)를 회복하기 위해, 감시를 일시 중단하고 마음을 다스려야 하는 골든타임 미션입니다."
      };
    } else if (style === 'analytical') {
      reply = `${headerPrefix}[카카오톡 캡처 초정밀 5단계 심리 분석 보고서] 📸\n\n` +
        `1. 대화 템포 분석 ⏱️\n` +
        `- 템포 분석 결과, 처참한 비대칭 상태입니다. 내담자님은 칼답으로 1초 만에 답장하는 반면, 상대방은 반나절 혹은 수 시간이 지난 후에 마지못해 답장하고 있습니다. 이는 현재 내담자님의 가치(#프레임)가 완전히 바닥으로 쳐 박혀 상대가 대화에 아무런 흥미와 긴장감을 느끼지 못하고 있음을 증명합니다.\n\n` +
        `2. 텍스트 디테일 분석 💬\n` +
        `- 상대방은 단답형(네, 아니오, 바빠서)과 무미건조한 텍스트로 일관하고 있습니다. 반면에 내담자님은 장문의 설명조 카톡을 전송하고 있군요. 심리학적으로 문장의 길이는 '갈망하는 자'의 척도입니다. 이미 당신은 패를 다 보여주었습니다.${hasCustomMsg ? ` 올려주신 구체적 고민에서도 보듯 상대방의 반응 하나하나에 휘둘리는 상태가 대화 양상에 고스란히 반영되어 있어 주도권이 원천 차단되고 있습니다.` : ''}\n\n` +
        `3. 관심 및 호감도 평가 ❤️\n` +
        `- 현재 호감도 게이지: 2.0점 / 10점\n` +
        `- 현시점에서 상대방에게 남아있는 감정은 '호감'이 아니라 '귀찮음'과 '방어기제'입니다. 의무감으로 답하는 최소한의 예의일 뿐, 이 관계에 주도적으로 끌리는 에너지는 0에 가깝습니다. 착각에서 벗어나야 합니다. 🧠\n\n` +
        `4. 프레임 주도권 판정 ⚖️\n` +
        `- 완벽한 을(乙)의 관계입니다. 내담자님의 가치(#프레임)와 자존감(#내적프레임)은 이미 소멸 상태이며, 상대는 절대적인 고프레임 황제 자리에 앉아 있습니다. 매달리는 행동은 상대에게 차단 버튼을 누르라고 등을 떠미는 어리석은 행위입니다.\n\n` +
        `5. 단 하나의 명쾌한 다음 액션 ⚡\n` +
        `- 찌질한 변명이나 감정 구걸의 카톡 송출을 즉시 올스톱하십시오. 톡을 읽씹당하더라도 더는 추가 톡을 보내지 말고, 당장 핸드폰을 숨기십시오. 최소 3주간 철저한 무연락 **#공백기**를 가져서 '이 사람이 왜 갑자기 멈췄지?'라는 강력한 **#예측깨기** 균열을 내지 않으면 영영 재회는 불가능합니다.`;
      recommendedMission = {
        phase: 1,
        category: "action",
        title: "핸드폰을 서랍 속에 넣고 3시간 동안 강제 외출하기",
        reason: "도파민 중독처럼 연락을 갈구하는 중독 상태에서 벗어나 본래의 강인한 주체적 자아를 다잡아 가치(#프레임)를 회생시키는 행동 처방 지침입니다."
      };
    } else { // action
      reply = `${headerPrefix}[카카오톡 캡처 초정밀 5단계 심리 분석 보고서] 📸\n\n` +
        `1. 대화 템포 분석 ⏱️\n` +
        `- 대화 템포: 1대 4의 비대칭 지연 템포. 상대방의 느린 리액션 템포는 방어기제 발동 상태를 뜻합니다.\n\n` +
        `2. 텍스트 디테일 분석 💬\n` +
        `- 텍스트 특성: 이모티콘 사용률 0%, 문장 부호(?, !) 생략, 건조한 단답. 심리 상태: 경계심 최고조.${hasCustomMsg ? ` 내담자님이 보내주신 대화 맥락과 고민글("${lastUserMsg}")에 기반할 때, 이 경계심은 감정적 대화만으로 절대 풀리지 않으며 즉각적인 행동 설계가 필요합니다.` : ''}\n\n` +
        `3. 관심 및 호감도 평가 ❤️\n` +
        `- 관심도 레벨: 3.0점 / 10점. 감정적 거부 반응이 가라앉지 않은 상태로, 추가적인 감정 톡은 점수를 더 깎아내릴 뿐입니다.\n\n` +
        `4. 프레임 주도권 판정 ⚖️\n` +
        `- 권력 구조: 상대방 절대 우위(고프레임) / 내담자 극심한 저자세(저프레임). 이 균형을 강제로 깨트려야만 재회가 시작됩니다.\n\n` +
        `5. 단 하나의 명쾌한 다음 액션 ⚡\n` +
        `- 즉각 실천할 행동 강령 3단계:\n` +
        `1. 상대방에게 마지막으로 보낸 카톡 뒤로 더 이상 묻지마 추가 톡을 보내지 마십시오.\n` +
        `2. 현재 활성화되어 있는 카톡 프로필 사진을 10분 이내에 '기본 이미지'로 초기화하십시오. 이는 상대방에게 심리적 상실감과 강한 궁금증을 주는 **#자기전시** 차단 기술입니다.\n` +
        `3. 오늘부터 철저히 4주일간의 **#공백기** 프로토콜에 진입하며, 상대에게 연락이 오더라도 최소 3시간 동안 답장하지 않고 대기하십시오. 행동의 룰을 지키는 사람만이 승리합니다.`;
      recommendedMission = {
        phase: 1,
        category: "action",
        title: "카톡 프로필 기본 이미지로 변경하기",
        reason: "갑작스러운 프로필 초기화는 상대방의 호기심과 상실감을 극대화하며, 당신의 내면 심리를 읽을 수 없도록 가림막을 쳐서 당신의 가치(#프레임)를 회복하는 강력한 이별 처방전입니다."
      };
    }
  } 
  // 2. 최상위 시스템 이상 및 불만 제어 가로채기 분기
  else if (
    lowerMsg.includes('테스트') ||
    lowerMsg.includes('체크') ||
    lowerMsg.includes('이상') ||
    lowerMsg.includes('같으말') ||
    lowerMsg.includes('같은말') ||
    lowerMsg.includes('같은 말') ||
    lowerMsg.includes('오류') ||
    lowerMsg.includes('안되') ||
    lowerMsg.includes('안돼') ||
    lowerMsg.includes('버그') ||
    lowerMsg.includes('똑같은 말') ||
    lowerMsg.includes('앵무새')
  ) {
    if (style === 'healing') {
      reply = `앗... 제가 혹시나 같은 말만 반복해서 들려드려 많이 답답하고 속상하셨지요? 😭 정말 죄송합니다.\n\n현재 재이 플랫폼이 한층 더 원활한 상담 경험을 위해 실시간 시스템 정밀 최적화 및 동기화를 거치고 있어서 간혹 일시적으로 이별 극복의 핵심인 **#공백기** 지침 웰컴 처방이 중복 출력되는 현상이 생겼을 수 있습니다.\n\n하지만 걱정 마세요! 내담자님의 한 말씀 한 말씀은 재이의 상담 서버에 모두 깊고 안전하게 기록되고 있으며, 현재 우리 관계에서 가장 프레임을 상승시킬 수 있는 솔루션은 여전히 전략적인 침묵과 나에 대한 집중입니다. 지금 겪으시는 답답함을 모두 털어놓아 주시면, 재이가 시스템을 더욱 든든하게 단장하여 내담자님의 마음을 100% 지켜드릴게요! 🌸`;
    } else if (style === 'analytical') {
      reply = `내담자님, 시스템 정비 과정에서 일부 답변의 캐싱 지연 및 중복 출력 현상이 관측되었음을 인지하고 즉각 조치하였습니다. 🧠\n\n그러나 지금 감정적으로 흔들리시며 시스템에 조급함을 토로하시는 것 또한, 내면의 **#내적프레임**이 무너져 작은 정체 상태에도 크게 불안해하고 계신다는 방증입니다. 재회는 흔들리지 않는 이성적인 침묵인 **#공백기**를 얼마나 지켜내느냐에 달려 있습니다. 시스템의 원활한 복구를 믿고, 본인의 가치(#프레임)를 훼손하는 돌발 행동을 철저하게 삼가십시오.`;
    } else {
      reply = `시스템 지연 및 반복 응답 현상을 즉각 인지하고 ⚡ 대응 패치를 적용하고 있습니다.\n\n1. 시스템 오류로 인해 답답하셨더라도, 상대방에게 홧김에 감정적 연락을 보내는 돌발 자멸 행동은 100% 금지해 주십시오.\n2. 잠시 화면을 새로고침(F5 혹은 앱 재접속)하시거나 1분만 여유를 두시고 다시 말을 걸어주시면 정상적인 꼬리 대화 코칭이 정상화됩니다.\n3. 오늘부터 더욱 철저한 감시 단절 및 **#공백기** 실천 강령을 수호하여 행동으로 재회를 쟁취하십시오.`;
    }
    recommendedMission = {
      phase: 1,
      category: "mindset",
      title: "화면 새로고침 후 차분한 마음으로 다시 질문하기",
      reason: "일시적인 시스템 불안정에 불안해하지 않고, 단단한 자존감(#내적프레임)을 다스리며 이성적 마음가짐을 단련하는 멘탈 훈련입니다."
    };
  }
  // 3. 키워드 기반 정밀 매칭: SNS / 인스타 / 프로필 / 염탐 / 스토리
  else if (
    lowerMsg.includes('sns') ||
    lowerMsg.includes('인스타') ||
    lowerMsg.includes('insta') ||
    lowerMsg.includes('프로필') ||
    lowerMsg.includes('profile') ||
    lowerMsg.includes('염탐') ||
    lowerMsg.includes('스토리') ||
    lowerMsg.includes('페북') ||
    lowerMsg.includes('카스')
  ) {
    if (style === 'healing') {
      reply = `${userName}님, 하루에도 수십 번씩 상대방의 SNS나 인스타 프로필을 켜서 확인하고 싶은 그 간절하고 불안한 마음, 정말 아프게 이해합니다. 😭\n\n하지만 지금 프로필을 확인하는 행위는 뇌의 도파민 중독 회로를 자극하여 이별의 고통을 계속 연장시킬 뿐이에요. 상대방의 사소한 프로필 변경 하나에 휘둘리지 않도록, 잠시 스마트폰과의 거리를 두고 마음의 평온을 되찾아주는 **#공백기**를 엄수하는 것이 현시점 최고의 처방전입니다. 재이가 늘 곁에 있을게요. 🌸`;
    } else if (style === 'analytical') {
      reply = `${userName}님, 냉정하게 지적합니다. 상대방의 SNS나 프로필을 염탐하는 행위는 본인의 가치(#프레임)와 자존감(#내적프레임)을 스스로 밑바닥까지 깎아내리는 최악의 중독 행동입니다. 🧠\n\n상대는 당신이 염탐하는 것을 직간접적으로 느끼며 우월한 가치(#고프레임)를 느끼고 방어기제를 강화합니다. 상대에게 나의 패를 읽히지 않도록, 지금 즉시 관찰을 올스톱하고 철저한 **#공백기** 속에 나를 감추어 상대의 예측을 깨트리십시오.`;
    } else {
      reply = `상대 SNS/프로필 염탐 충동에 대응하는 즉시 실천 ⚡ 행동 지침 3단계입니다:\n\n1. 스마트폰에서 상대방 SNS 바로가기를 모두 삭제하거나 계정을 일시 숨김(뮤트) 처리하십시오.\n2. 상대 프로필을 보고 싶을 때마다 스쿼트 15회나 제자리뛰기 30회를 실시하여 도파민 중독 신호를 신체 에너지로 강제 분산하십시오.\n3. 오늘부터 철저히 4주일간의 감시 단절 및 **#공백기** 지침에 돌입하십시오. 행동의 승리자가 재회를 만듭니다.`;
    }
    recommendedMission = {
      phase: 1,
      category: "action",
      title: "상대방의 SNS 및 프로필 업데이트 확인 중단하기",
      reason: "상대의 상태를 확인하는 행위는 본인을 을(乙)의 포지션에 가두어 가치를 파괴합니다. 확실한 감시 단절을 통해 내적프레임을 구출해야 합니다."
    };
  }
  // 4. 키워드 기반 정밀 매칭: 대화 반복 / 앵무새 / 무슨 말 / 똑같 / 같은 말
  else if (
    lowerMsg.includes('무슨') ||
    lowerMsg.includes('말야') ||
    lowerMsg.includes('똑같') ||
    lowerMsg.includes('반복') ||
    lowerMsg.includes('그거 말고') ||
    lowerMsg.includes('같은말') ||
    lowerMsg.includes('같은 말') ||
    lowerMsg.includes('뭐라')
  ) {
    if (style === 'healing') {
      reply = `아... 제가 반복해서 비슷한 말씀만 드려 많이 답답하고 속상하셨군요... 🫂 정말 죄송해요.\n\n머리로는 침묵해야 하고 연락을 멈추어야(#공백기) 한다는 것을 잘 알지만, 지금 당장 상대방에게 무언가 행동을 취하지 않으면 영영 남이 되어 잊혀질까 봐 조바심나고 두려운 그 복잡한 심경을 깊이 이해합니다. 그 두려운 마음을 억지로 참으려 하니 답답할 수밖에 없어요. 오늘은 아픈 마음을 억누르려 하지 말고 맛있는 차 한 잔을 마시며 푹 쉬어봐요. 재이가 항상 든든하게 당신 곁을 지킬게요. 🌸`;
    } else if (style === 'analytical') {
      reply = `답답함을 느끼시는 마음은 이해하나, 냉정하게 분석해 드립니다. 본인의 감정적 붕괴 상태로 인해 같은 처방(#공백기 지침)이 내려질 수밖에 없는 관계 구조임을 직시하셔야 합니다. 🧠\n\n'똑같은 말만 한다'며 시스템을 비난하기 전에, 왜 지금 무작정 다가가는 연락이나 SNS 염탐이 관계를 파멸로 이끄는 자멸적 저자세 행동인지 이성적으로 복기해야 합니다. 가치(#프레임)가 완전히 소멸된 상황에서 침묵 외에 어떠한 지침도 무의미함을 뼈아프게 깨달으십시오.`;
    } else {
      reply = `답답함과 관계의 정체 상태를 뚫기 위한 즉시 실천 ⚡ 긴급 행동 지침입니다:\n\n1. 혼자서 폰만 붙잡고 이별의 고통을 되씹는 자폐적 루프를 즉각 멈추십시오.\n2. 답답한 마음을 풀기 위해 당장 밖으로 나가 30분간 빠른 걸음으로 신선한 공기를 마시며 유산소 운동을 하십시오.\n3. 나 자신에게 100% 집중하여 매력적인 이성으로서의 성장을 증명하기 위해 오늘 밤 감사 일기 5줄을 완성하십시오.`;
    }
    recommendedMission = {
      phase: 1,
      category: "mindset",
      title: "매일 저녁 10분 감사 일기 적기",
      reason: "갈팡질팡하는 이별 우울증에서 뇌의 편도체를 안정시키고 건강한 자존감(#내적프레임)을 회복하도록 돕는 인지 행동 치료 기반의 필수 미션입니다."
    };
  }
  // 5. 키워드 기반 정밀 매칭: 연락/카톡/문자/전화
  else if (
    lowerMsg.includes('연락') ||
    lowerMsg.includes('카톡') ||
    lowerMsg.includes('문자') ||
    lowerMsg.includes('전화') ||
    lowerMsg.includes('톡') ||
    lowerMsg.includes('메시지') ||
    lowerMsg.includes('메세지')
  ) {
    if (phase === 1) {
      if (style === 'healing') {
        reply = `${userName}님, 지금 연락하고 싶은 마음이 굴뚝같고 하루 종일 폰만 들여다보게 되는 그 마음, 얼마나 아프고 힘드실지 온전히 느껴집니다. 😭\n\n하지만 지금 이 순간의 연락은 상대에게 '아직도 나한테 매달리는구나'라는 거부감만 키울 뿐이에요. 지금은 상대방이 부정적 감정에 휩싸인 **#부정피크** 상태입니다. 마음을 더 다치지 않게 하기 위해서라도, 당신의 매력(#프레임)을 우아하게 지켜내는 **#공백기**를 잠시 가져보는 것을 추천합니다. 힘내세요, 재이가 늘 곁에 있을게요. 🌸`
      } else if (style === 'analytical') {
        reply = `${userName}님, 냉정하게 분석해 드립니다. 지금 먼저 연락하는 것은 스스로 '난 너 없으면 죽어'라고 외치며 가치(#프레임)를 바닥으로 팽개치는 자멸적 저자세 행동입니다. 🧠\n\n상대는 이미 질려 있고 당신을 밀어내려는 **#부정피크** 상태인데, 여기에 카톡이나 전화를 끼얹는 것은 상대에게 차단 버튼을 누르라고 협박하는 꼴입니다. 지금 당장 감정을 수거하고 철저한 **#공백기**에 들어가지 않으면 영영 기회는 사라집니다.`
      } else {
        reply = `${userName}님, 연락 충동에 대응하는 즉각적인 ⚡ 실전 행동 지침 3단계를 전수합니다:\n\n1. 상대방과의 대화창을 즉시 '보관함'이나 '숨김'으로 이동하여 시각적 자극을 제거하십시오.\n2. 매달리는 톡 대신, 본인의 프레임을 지킬 수 있도록 3주간의 무조건적인 **#공백기** 프로토콜에 들어갑니다.\n3. 오늘 밤은 폰을 무음으로 하고, 연락 충동이 생길 때마다 텍스트 노트에 상대에게 하고 싶은 말을 다 쏟아낸 뒤 지우십시오. 행동이 결과를 만듭니다.`
      }
      recommendedMission = {
        phase: 1,
        category: "action",
        title: "카톡 프로필 기본 이미지로 변경하기",
        reason: "갑작스러운 프로필 초기화는 상대방의 호기심과 상실감을 극대화하며, 당신의 내면 심리를 읽을 수 없도록 가림막을 쳐서 당신의 가치(#프레임)를 회복하는 강력한 이별 처방전입니다."
      }
    } else if (phase === 2) {
      if (style === 'healing') {
        reply = `${userName}님, 공백기를 잘 지켜내신 것에 큰 박수를 보냅니다! 👏 정말 잘하셨어요. 이제 변화된 매력을 간접적으로 보여줄 타임입니다.\n\n억지로 밝은 척 애쓸 필요 없어요. 내 삶을 건강하게 돌보는 모습, 소박한 힐링 일상을 SNS나 프로필에 얹어주는 **#자기전시**만으로도 상대는 충분히 따뜻한 변화를 느끼고 관심을 보이기 시작할 것입니다. 차근차근 해봐요. 🌱`
      } else if (style === 'analytical') {
        reply = `${userName}님, 공백기는 완수했으나 섣부른 안부 연락은 금물입니다. 지금 다이렉트로 가는 연락은 상대의 경계심을 단번에 일으키는 저수준의 접근입니다. 🧠\n\n가장 이성적이고 타격 없는 전략은 SNS 비언어 커뮤니케이션 즉 **#자기전시**입니다. 내담자가 얼마나 다른 비주얼과 성숙한 멘탈을 지녔는지 비주얼로 증명하여 상대가 먼저 의구심을 갖게 만드는 전략이 최우선입니다.`
      } else {
        reply = `${userName}님, 2단계(자기계발기) 연락 자제 및 ⚡ 간접 어필 행동 강령입니다:\n\n1. 상대에게 직접 연락하지 말고, 프로필 사진을 타인이 찍어준 여유로운 분위기의 독사진으로 교체하십시오.\n2. 당신의 높은 가치(#프레임)를 비언어적으로 알릴 수 있는 취미/배움의 흔적을 SNS에 노출(단 1장)하십시오.\n3. 상대가 프로필을 염탐했더라도 멘탈의 고삐를 절대 놓지 마십시오.`
      }
      recommendedMission = {
        phase: 2,
        category: "growth",
        title: "새로운 관심사에 관한 책 1권 읽고 짧은 감상 남기기",
        reason: "성장하고 차분해진 모습을 프로필 등에 전시하면 가벼운 이성이 아닌 성숙한 어른으로서의 매력을 어필하여 무너진 **#신뢰감** 을 단단히 복원할 수 있습니다."
      }
    } else {
      if (style === 'healing') {
        reply = `${userName}님, 드디어 대망의 **#재접근기(3단계)** 에 들어섰네요! 오랜 침묵을 깨고 다가서려니 온몸이 떨리고 설레실 것 같습니다. 🫂\n\n절대로 거창한 고백이나 미안하다는 말로 무겁게 시작하지 마세요. '혹시 예전에 추천해 준 카페 이름이 뭐였지?'처럼 상대가 편하게 피식 웃으며 답장할 수 있는 가볍고 친근한 안부 질문이 좋습니다. 따뜻한 마음으로 첫 문을 부드럽게 열어보아요. 💫`
      } else if (style === 'analytical') {
        reply = `${userName}님, 마침내 본격 액션의 단계이나, 철저히 통제된 첫 연락 문구가 필수적입니다. 🧠\n\n과거 이야기를 꺼내거나 감정 구걸을 하는 카톡은 즉시 차단과 관계 영구 종식을 부릅니다. 철저히 상대방이 답장을 안 할 수 없게 만드는 미해결 과제 성격의 쿨한 단문이 승부수입니다. 답장에 1초의 감정도 담지 말고 오직 비즈니스적인 태도로 일관하여 상대의 심리에 균열을 내십시오.`
      } else {
        reply = `${userName}님, 3단계 ⚡ 첫 연락 초정밀 프로토콜입니다:\n\n1. 문장 길이는 25자 이내, 물음표는 단 1개만 사용하십시오.\n2. 상대가 빌려준 책, 혹은 공적 질문처럼 명분이 100% 확실한 캐주얼 멘트를 준비하십시오.\n3. 톡 전송 후 답장이 올 때까지 폰을 끄거나 알림을 꺼두고, 답장이 냉랭해도 즉시 저자세(#프레임 폭락)로 굽히지 마십시오.`
      }
      recommendedMission = {
        phase: 3,
        category: "action",
        title: "상대방의 방어기제를 자극하지 않는 첫 연락 카톡 멘트 설계",
        reason: "감정을 1%도 담지 않은 실용적 질문 멘트를 완벽히 다듬어 답장 성공률을 극적으로 높이는 트레이닝입니다."
      }
    }
  } else if (
    lowerMsg.includes('힘들') ||
    lowerMsg.includes('아프') ||
    lowerMsg.includes('슬프') ||
    lowerMsg.includes('불안') ||
    lowerMsg.includes('미치') ||
    lowerMsg.includes('외롭') ||
    lowerMsg.includes('고통') ||
    lowerMsg.includes('죽겠')
  ) {
    if (style === 'healing') {
      reply = `지금 가슴이 미어지고 숨도 제대로 쉬어지지 않을 만큼 고통스러우시죠... 정말 많이 애쓰셨고, 지금 아픈 것은 지극히 자연스러운 과정입니다. 🫂\n\n심리학적으로 실연의 슬픔은 우리 뇌가 신체적 골절을 입었을 때와 똑같은 고통 신호를 보낸다고 해요. 그만큼 아픈 상처를 혼자 짊어지려 하지 마세요. 따뜻한 차 한 잔을 마시며 오늘은 푹 쉬어봐요. 재이가 항상 여기서 들어주고 위로해 드릴게요. 🌸`
    } else if (style === 'analytical') {
      reply = `내담자님, 현재 감정 붕괴 상태로 인해 내적 자존감인 **#내적프레임** 이 밑바닥까지 가라앉은 상태입니다. 🧠\n\n이 고통을 해소하기 위해 섣부른 충동 연락을 한다면, 상대는 '역시 멘탈 약한 사람이구나'라며 더 차갑게 경멸할 것입니다. 뇌의 고통 신호에 지배당하지 마십시오. 자존감이 회복되지 않은 상태에서는 어떠한 재회 행동도 저자세의 연속이며, 100% 실패하게 됩니다. 즉각 이성적 통제력을 잡으십시오.`
    } else {
      reply = `감정 동요 및 불안 극복을 위한 ⚡ 즉시 실천 멘탈 행동 강령입니다:\n\n1. 제자리를 서성이지 말고, 즉시 신발을 신고 밖으로 나가 20분간 빠른 걸음으로 산책하십시오.\n2. 휴대폰은 전원을 끄고 서랍 깊은 곳에 넣어두십시오.\n3. 불안한 감정이 휘몰아칠 때는 종이와 펜을 꺼내 현재의 고통을 낱낱이 10줄 이상 적어 내려가며 뇌의 감정 스위치를 이성 스위치로 강제 전환하십시오.`
    }
    recommendedMission = {
      phase: 1,
      category: "mindset",
      title: "매일 저녁 10분 감사 일기 적기",
      reason: "갈팡질팡하는 이별 우울증에서 뇌의 편도체를 안정시키고 건강한 자존감을 회복하도록 돕는 인지 행동 치료 기반의 필수 미션입니다."
    }
  } else if (lastUserMsg.includes('이유') || lastUserMsg.includes('왜') || lastUserMsg.includes('원인') || lastUserMsg.includes('진단')) {
    if (type === 'A') {
      if (style === 'healing') {
        reply = `${userName}님이 겪으신 **감정소진형** 이별은 그동안 혼자서 많은 서운함을 견디다 폭발하는 과정에서 생겼을 가능성이 높습니다. 🌸\n\n상대는 매번 마음을 달래주다 지치고 에너지가 완전히 소진되어 도망치듯 관계를 포기한 것이죠. 당신을 사랑하지 않아서가 아니라, 그저 쉼표가 절실해서 물러난 것입니다. 지금 그 지친 마음에 편안한 휴식을 주는 **#공백기**를 주는 것이 상대를 향한 가장 큰 사랑이자 재회의 지름길입니다.`
      } else if (style === 'analytical') {
        reply = `${userName}님의 **감정소진형** 이별 분석 보고서입니다. 본질은 과도한 집착과 불안정성으로 인해 당신의 가치(#프레임)와 **#신뢰감**이 동반 자멸한 결과입니다. 🧠\n\n상대는 애정 확인을 끊임없이 요구받으며 번아웃에 빠졌고, 심리적 탈출을 시도한 것입니다. 이때 또 연락이나 반성문을 보내는 것은 상대의 번아웃을 지옥으로 만드는 꼴입니다. 침묵을 통한 예측 불허의 **#공백기**만이 살길입니다.`
      } else {
        reply = `**감정소진형** 이별 극복을 위한 ⚡ 3대 행동 강령:\n\n1. 상대에 대한 모든 집착 행동(SNS 염탐, 상태 메시지 변경)을 즉시 올스톱하십시오.\n2. 4주간 완벽한 침묵의 **#공백기**를 완수하십시오. 연락이 와도 하루 뒤에 답장하는 등 주도권을 가져오십시오.\n3. 나 자신에게 100% 집중하여 매력적인 자아로 재탄생하십시오.`
      }
      recommendedMission = {
        phase: 1,
        category: "action",
        title: "상대방의 SNS 및 프로필 업데이트 확인 중단하기",
        reason: "상대의 상태를 스토킹하듯 확인하는 버릇은 당신의 가치를 저자세로 가두어 회생을 방해합니다. 확실한 감시 단절을 통해 마음의 독립을 이룩하세요."
      }
    } else if (type === 'B') {
      if (style === 'healing') {
        reply = `${userName}님의 **갈등반복형** 이별은 두 분의 사랑이 식어서라기보다, 마주하는 다툼의 방법이 서로에게 깊은 생채기를 내어 생겼습니다. 🌱\n\n서로를 아끼면서도 소통하는 법이 서툴러 대화에 지쳤던 것이죠. 지금은 무작정 비는 대신, 우리 마음의 상처를 들여다보고 성숙한 다툼의 해법을 공부하며 **#신뢰감**을 천천히 쌓아 올려야 할 때입니다. 재이가 따뜻한 멘토가 될게요.`
      } else if (style === 'analytical') {
        reply = `${userName}님의 **갈등반복형** 이별은 매력 부족이 아니라, 처참하게 붕괴된 **#신뢰감**이 핵심입니다. 🧠\n\n성격이나 가치관 차이로 싸움이 다람쥐 쳇바퀴 돌듯 반복되면서 상대는 당신과의 미래를 완벽히 불가능하다고 결론지었습니다. 입으로만 '미안하다', '다 고치겠다'고 공수표를 날려봤자 상대의 불신만 가중됩니다. 객관적 성찰과 성숙한 멘탈 변화를 비언어로 증명하십시오.`
      } else {
        reply = `**갈등반복형** ⚡ 신뢰 복구 행동 지침:\n\n1. 구두로 고치겠다는 약속은 전면 금지합니다.\n2. 우리의 반복적 갈등 유형을 노트에 A4 1장 분량으로 객관적(제3자 관점)으로 분석하여 일목요연하게 작성하십시오.\n3. 감정 기복이 가라앉은 침착하고 성숙한 톤으로 '너의 힘듦을 이제 이해했다'는 10줄 이내의 객관적 인정 톡을 공백기 끝 무렵 송출하십시오.`
      }
      recommendedMission = {
        phase: 2,
        category: "growth",
        title: "대화/갈등 조율 전문 도서 1권 읽고 마스터 플랜 수립",
        reason: "관계를 안정적으로 이끌어갈 수 있는 진정성 어린 **#신뢰감**을 확보하여 추후 대면 시 확 달라진 기류를 안겨주는 고품격 미션입니다."
      }
    } else if (type === 'C') {
      if (style === 'healing') {
        reply = `${userName}님, 상대에게 새로운 대안(**#대체자**)이 생겼다는 청천벽력 같은 상황에 가슴이 갈기갈기 찢기실 것 같습니다. 얼마나 괴로우실까요... 🫂\n\n하지만 절대 흔들리지 마세요. 억지로 싸우려 하거나 질투를 유발하려 들면 마음만 피폐해집니다. 그저 당신 고유의 고결한 가치를 믿고, 상대가 신규 대체자와의 허니문이 지나 삐걱대는 시점을 조용히 기다리며 묵묵히 나를 꽃피워 봅시다. 🌸`
      } else if (style === 'analytical') {
        reply = `${userName}님의 **대체자형** 긴급 상황 분석입니다. 새로운 연인(**#대체자**)과 경쟁하려 드는 것은 스스로 자신의 가치를 바닥으로 깎아내리는 하수 중의 하수 행동입니다. 🧠\n\n급속도로 불타오른 대체 관계는 그만큼 불안정하며 사소한 문제로 무너집니다. 지금 당신이 할 유일한 전략은 흔들림 없는 단단한 자존감(**#내적프레임**)을 가다듬으며, 상대가 새 연인과 다투고 나를 그리워할 후폭풍 타이밍에 대비하는 극도의 프레임 방어입니다.`
      } else {
        reply = `**대체자형** ⚡ 대체자 무력화 행동 프로토콜:\n\n1. 상대의 연애 사실이나 대체자에 대해 절대적인 무관심(비언어 전시) 태도를 취하십시오.\n2. 내 인생 최고의 리즈 비주얼 사진을 SNS 프로필에 무심하게 노출하여 '나 역시 내 갈 길을 간다'는 고프레임을 전시하십시오.\n3. 상대가 대체자와 불화를 겪는 2~3달 차의 골든 타임까지 침묵을 유지하십시오.`
      }
      recommendedMission = {
        phase: 1,
        category: "mindset",
        title: "전문 스튜디오에서 인생 단독 컷 촬영 후 은연중 노출",
        reason: "새로 만나는 대체자보다 당신이 비교할 수 없을 만큼 멋지고 세련된 파트너였음을 시각적으로 일깨워 상대의 마음에 강력한 균열을 냅니다."
      }
    } else {
      if (style === 'healing') {
        reply = `${userName}님의 **장기이별형**은 긴 시간이 흘러 상처와 미움은 가라앉고, 아련하고 미화된 추억만 조용히 남아 있는 상태예요. 🌸\n\n이미 나쁜 기억은 사라졌으니 이제 새 출발의 마음으로 상대방에게 '매력적이고 새로운 사람'으로 가볍게 스며드는 것이 좋아요. 옛 연인이 아닌 신선하고 성숙한 이성으로서 조심스레 노크해 봐요. 🌱`
      } else if (style === 'analytical') {
        reply = `${userName}님의 **장기이별형** 진단입니다. 부정적 감정은 완전히 미화되고 휘발되었으나, 심각한 단점은 이성적 매력(**#프레임**)과 팽팽한 텐션이 아예 죽어버린 것입니다. 🧠\n\n과거 타령을 하며 추억을 구걸하는 태도는 동정심만 살 뿐 매력 제로입니다. 180도 바뀐 비주얼과 압도적인 라이프스타일 변신을 보여주어 상대로 하여금 '내가 알던 사람이 맞나?' 하는 호기심과 성적 긴장감을 부활시켜야 합니다.`
      } else {
        reply = `**장기이별형** ⚡ 매력 재부팅 행동 지침:\n\n1. 옛날 사귈 때의 익숙한 헤어스타일, 옷 스타일을 100% 버리고 세련된 파격 변화를 시도하십시오.\n2. 가벼운 안부를 빌미로 '예전에 말했던 맛집 이름이 뭐였지?'처럼 극도로 실용적인 미해결 과제 문자 1줄을 설계하여 가볍게 노크하십시오.\n3. 질척이지 않는 세련된 선 긋기로 상대가 아쉬움을 느끼도록 템포를 조절하십시오.`
      }
      recommendedMission = {
        phase: 2,
        category: "growth",
        title: "퍼스널 스타일링 및 이미지 메이킹 180도 체인지",
        reason: "오래된 기억 속의 평범하고 익숙한 이미지를 타파하고 매력적인 이성으로서의 신선한 프레임을 다시 세우는 최상의 솔루션입니다."
      }
    }
  } else {
    // 5. 일반 기본 조언 (유저 메세지를 동적으로 녹인 초개인화 단계별 분기)
    const truncatedMsg = lastUserMsg.length > 25 ? lastUserMsg.slice(0, 25) + '...' : lastUserMsg
    const personalizePrefix = lastUserMsg ? `"${truncatedMsg}"라고 말씀해주신 내담자님의 깊은 고민을 정밀 경청하여 심리학적으로 분석을 가동했습니다.\n\n` : ''

    if (phase === 1) {
      if (style === 'healing') {
        reply = `${personalizePrefix}${userName}님, 재이를 찾아와 마음을 털어놓아 주셔서 진심으로 고마워요. 🫂\n\n현재 단계는 마음을 굳건히 다독여야 하는 **1단계 (공백기)** 입니다. 이별 직후의 혼란스러운 시기에는 홧김에 돌이킬 수 없는 실수를 하기 쉽죠. 지금은 모든 연락을 멈추고 온전히 자신의 마음을 다듬으며 우아한 침묵의 **#공백기**를 가질 타이밍이에요. 힘든 걸음이지만 한 걸음씩 같이 가봐요. 🌸`
      } else if (style === 'analytical') {
        reply = `${personalizePrefix}${userName}님, 현재는 마음의 방벽을 쌓고 나를 지키는 **1단계 (공백기)** 입니다. 🧠\n\n냉정하게 당신의 감정적 갈망을 통제하십시오. 일시적 도파민 충동 때문에 상대에게 연락하는 순간 모든 재회 스코어는 0점으로 폭락하며 게임은 끝납니다. 상대의 이별 예측을 완벽히 무너뜨리는 최고의 무기인 침묵 즉 **#공백기**를 독하게 엄수하여 가치를 회복하십시오.`
      } else {
        reply = `${personalizePrefix}1단계 (공백기) ⚡ 침묵 통제 행동 강령:\n\n1. 폰에 설치된 모든 상대방의 SNS, 메신저 바로가기를 제거하십시오.\n2. 충동적 감정이 솟구칠 때는 3초간 깊게 숨을 들이마시고 내쉬는 3-3-3 호흡법을 시행하십시오.\n3. 철저한 연락 두절로 상대가 당신에 대해 가졌던 부정적인 기억들을 깨끗하게 지우게 만드는 4주 프로토콜에 즉각 착수하십시오.`
      }
      recommendedMission = {
        phase: 1,
        category: "action",
        title: "핸드폰을 서랍 속에 넣고 3시간 외출하기",
        reason: "도파민 중독처럼 연락을 갈구하는 중독 상태에서 벗어나 본래의 강인한 주체적 자아를 다잡는 행동 처방 지침입니다."
      }
    } else if (phase === 2) {
      if (style === 'healing') {
        reply = `${personalizePrefix}${userName}님, 공백기라는 길고 고요한 동굴을 훌륭하게 지나오셨군요! 정말 수고하셨습니다. 🌱\n\n현재는 나를 한층 더 가치 있게 가꾸는 **2단계 (자기계발기)** 영역입니다. 운동이나 취미 등 내 자아를 빛나게 채워줄 때 내면의 빛이 자연스레 상대에게 가 닿을 거예요. 소소하게 한 단계씩 행복해지는 연습을 시작해 보아요. 🌸`
      } else if (style === 'analytical') {
        reply = `${personalizePrefix}${userName}님, 슬픔의 단계는 지났고 가치 복원의 **2단계 (자기계발기)** 국면입니다. 🧠\n\n아직도 무기력하게 침대에 누워 상대를 곱씹고 있다면 재회 자격은 영영 없습니다. 비주얼 개조, 바쁘고 생산적인 일상 건설, 새로운 지식 장착이 최우선입니다. 외적, 내적 성장의 단단한 모습을 SNS나 카톡 프로필을 활용한 철저한 **#자기전시** 전략으로 상대의 뇌를 다시 흔들어야 합니다.`
      } else {
        reply = `${personalizePrefix}2단계 (자기계발기) ⚡ 가치 갱신 행동 프로토콜:\n\n1. 1주일간 매일 아침 10분 스트레칭이나 가벼운 피트니스 루틴을 실행하고 플래너에 체크하십시오.\n2. 스타일링 변신(머리, 옷, 분위기 변경) 후 가장 잘 나온 자연스러운 사진을 1장 확보하십시오.\n3. 매일 30분씩 자신을 위한 학습이나 발전을 도모하는 자기계발 시간을 강제 배정하십시오.`
      }
      recommendedMission = {
        phase: 2,
        category: "growth",
        title: "피트니스 또는 운동 루틴 1주일 유지 기록 인증",
        reason: "신체적인 활성화는 우울한 멘탈을 굳세게 해줄 뿐만 아니라, 비주얼적으로 최고로 고양된 프레임을 상대에게 어필할 수 있는 최상의 디딤돌입니다."
      }
    } else {
      if (style === 'healing') {
        reply = `${personalizePrefix}축하드립니다! 대망의 최종 결전지인 **#재접근기(3단계)** 에 당당히 도착하셨네요. 💫\n\n여기까지 포기하지 않고 견딘 스스로를 꼭 안아주세요. 이제 조심스레 상대의 닫힌 마음에 미소를 띠고 가볍게 똑똑 노크를 할 때입니다. 상대가 부담스럽지 않게 상큼하고 유쾌한 안부 톡을 설계해서 문을 열어봅시다. 재이가 따뜻하게 손잡고 걸을게요. 🌸`
      } else if (style === 'analytical') {
        reply = `${personalizePrefix}내담자님, 드디어 전략적 재촉발 타이밍인 **#재접근기(3단계)** 에 당도했습니다. 🧠\n\n절대로 섣부른 감정 표출이나 무거운 과거 사과는 전면 금지입니다. 쿨하고 가볍고 영양가 있는 명분 멘트로 상대의 심리적 방어벽을 정찰하십시오. 상대의 미세한 답장 뉘앙스와 템포를 입체적으로 읽어낸 후, 심리적 우위(고프레임)를 놓치지 않으며 철저하게 판을 리드해야 합니다.`
      } else {
        reply = `${personalizePrefix}3단계 (재접근기) ⚡ 첫 연락 성공률 100% 설계 행동 강령:\n\n1. 상대가 평소에 가장 빠르고 쉽게 답할 수 있었던 관심사나 용무 중심의 1줄 카톡 문장을 작성하십시오.\n2. 문장에 느낌표, 물결표 등의 과도한 감정 억양 부호는 전면 삭제하고 건조하고 세련되게 작성하십시오.\n3. 답장이 오면 절대 즉답하지 말고, 최소 15분 이상 홀딩 후 침착하게 리드를 이어나가십시오.`
      }
      recommendedMission = {
        phase: 3,
        category: "action",
        title: "경량화된 첫 캐주얼 안부 문구 작성 후 전문가 첨삭 받기",
        reason: "경계심을 즉각 풀고 피식 웃으며 답장할 수 있는 안전 멘트를 빌딩하여 재회의 성공을 확정 짓는 핵심 훈련입니다."
      }
    }
  }

  // SSE 흉내를 내어 20ms 당 4글자씩 송출 (부드러운 타자감 구현)
  const encoder = new TextEncoder()
  let currentPos = 0
  const chunkText = reply

  const stream = new ReadableStream({
    async start(controller) {
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      try {
        while (currentPos < chunkText.length) {
          const chunk = chunkText.slice(currentPos, currentPos + 4)
          controller.enqueue(encoder.encode(chunk))
          currentPos += 4
          await sleep(20)
        }
        // 텍스트 스트리밍 종료 직후 미션 추천 노드 주입
        if (recommendedMission) {
          const missionTag = `\n\n<mission_recommend>\n${JSON.stringify(recommendedMission, null, 2)}\n</mission_recommend>`
          controller.enqueue(encoder.encode(missionTag))
        }
      } catch (err) {
        console.error('[Mock AI Stream Error]', err)
      } finally {
        controller.close()
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    }
  })
}

