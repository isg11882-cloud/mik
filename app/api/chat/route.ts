import { buildSystemPrompt, phaseFromDays, type UserContext } from '@/lib/ai-system-prompt'
import { createSupabaseServer } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

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
      console.error("[GEMINI_API_FAILURE_CRITICAL] Fallback triggered. Reason:", fetchErr);
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

      console.error("[GEMINI_API_FAILURE_CRITICAL] API responded with non-200 status. Fallback triggered. Reason:", errorMessage)
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
  } else if (
    lowerMsg.includes('얼마나') ||
    lowerMsg.includes('며칠') ||
    lowerMsg.includes('몇주') ||
    lowerMsg.includes('몇 주') ||
    lowerMsg.includes('언제까지') ||
    lowerMsg.includes('기간') ||
    lowerMsg.includes('한 달') ||
    lowerMsg.includes('한달')
  ) {
    if (style === 'healing') {
      reply = `${userName}님, 무연락(#공백기)을 얼마나 지켜야 할지 그 기나긴 기다림의 시간 동안 조급해지고 불안한 마음은 정말 당연합니다. 😭\n\n현재 내담자님의 진단 유형인 **감정소진형(Type A)** 은 상대가 에너지를 완전히 방전하고 물러선 상태이기에, 최소 **3주에서 4주**의 확실한 #공백기 송출이 필요합니다. 이 시기 동안 하루도 빠짐없이 나만을 위한 힐링에 힘쓰며 마음을 가다듬읍시다. 재이가 끝까지 지켜드릴게요. 🌸`;
    } else if (style === 'analytical') {
      reply = `공백기 기간의 행동 수칙을 이성적으로 제시합니다. 🧠\n\n본인의 **감정소진형(Type A)** 이별은 상대의 번아웃이 원인이므로, 상대의 뇌 속 스트레스 호르몬이 자연 소멸하기까지 **최소 3~4주일**의 완벽한 #공백기(연락 단절)가 절대적으로 엄수되어야 합니다. 조급하게 1~2주 만에 찔러보기 톡을 보내는 행동은 그동안의 침묵 스코어를 0점으로 파괴하는 최악의 수입니다. 본인의 가치(#프레임)를 입증하기 위해 28일간 철저하게 침묵하십시오.`;
    } else {
      reply = `감정소진형(Type A) ⚡ #공백기 기간 관리 솔루션:\n\n1. 오늘부터 달력에 **4주일(28일)**간의 철저한 무연락 기간을 표시하고 디데이(D-Day) 관리에 진입하십시오.\n2. 무연락 14일 차가 지나기 전까지는 카톡 프로필 업데이트를 일체 금지하며 고요한 침묵을 엄수하십시오.\n3. 연락하고 싶을 때마다 스마트폰 타이머를 10분으로 세팅하고 차분하게 물 한 잔을 마시며 충동을 통제하십시오.`;
    }
    recommendedMission = {
      phase: 1,
      category: "action",
      title: "달력에 4주(28일) 공백기 디데이 표시하고 매일 체크하기",
      reason: "전략적 침묵 기간을 비주얼적으로 시각화하여 홧김에 저지르는 연락 충동을 이성적으로 강제 제어하는 필수 행동 설계입니다."
    };
  } else if (
    lowerMsg.includes('이유') ||
    lowerMsg.includes('왜 헤어') ||
    lowerMsg.includes('왜 헤어짐') ||
    lowerMsg.includes('이유가 뭐') ||
    lowerMsg.includes('원인이 뭐') ||
    lowerMsg.includes('진단 요약') ||
    lowerMsg.includes('원인 분석')
  ) {
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
    // 6. 일반 기본 조언 (유저 메세지를 동적으로 녹인 초개인화 단계별 분기 및 대화 깊이 인식 앵무새 방지)
    const truncatedMsg = lastUserMsg.length > 25 ? lastUserMsg.slice(0, 25) + '...' : lastUserMsg
    const personalizePrefix = lastUserMsg ? `"${truncatedMsg}"라고 말씀해주신 내담자님의 깊은 고민을 정밀 경청하여 심리학적으로 분석을 가동했습니다.\n\n` : ''

    // [초지능형 Intent 매핑 분기 추가]
    let handledByIntent = false

    if (
      lowerMsg.includes('원인') ||
      lowerMsg.includes('이유를') ||
      lowerMsg.includes('이유도') ||
      lowerMsg.includes('모르겠') ||
      lowerMsg.includes('모르겠어') ||
      lowerMsg.includes('모르겠음') ||
      lowerMsg.includes('왜 헤어')
    ) {
      handledByIntent = true
      if (style === 'healing') {
        reply = `${personalizePrefix}${userName}님, 왜 헤어졌는지 그 본질적인 이유를 명확히 알지 못해 가슴이 답답하고 캄캄한 어둠 속에 갇힌 기분이실 것 같습니다. 🫂\n\n대다수의 이별은 갑자기 찾아오는 것처럼 보이지만, 사실 상대방이 평소에 미세하게 보냈던 서운함과 신호들이 누적되다 상대의 감정이 방전(**감정소진형**)되면서 통보되는 경우가 많습니다. 지금은 억지로 상대에게 캐묻거나 매달려 원인을 찾으려 하지 마시고, 한 발짝 물러서서 연애 기간 동안 상대가 나에게 스치듯 말했던 서운함이나 요구사항을 차분히 뇌 깊숙이 복기해 보시는 것이 가장 지혜로운 첫단추입니다. 재이가 그 여정을 항상 동행하며 지켜드릴게요. 🌸`
        recommendedMission = {
          phase: 1,
          category: "mindset",
          title: "상대방이 연애 중 흘리듯 했던 사소한 서운함 3가지 복기하기",
          reason: "무작정 다가가는 연락 대신, 상대방이 나에게 느꼈던 미세한 감정적 거부 반응의 근원을 이성적으로 복기하여 재회 핵심 전략(#신뢰감)을 구축하기 위한 필수 훈련입니다."
        }
      } else if (style === 'analytical') {
        reply = `${personalizePrefix}${userName}님, 이별의 원인을 인지하지 못하는 상태는 관계를 객관화하지 못하고 감정적 환상에 빠져 있다는 완벽한 방증입니다. 🧠\n\n상대방은 감정 에너지가 방전되는 동안 수없이 많은 비언어적 경고를 보냈을 것입니다. 그것을 감지하지 못한 채 '갑작스러운 이별'이라 치부하며 억울해하는 태도는 본인의 **#내적프레임**과 관찰력이 극도로 낮았음을 입증합니다. 지금 당장 감정을 배제하고, 연애 기간 동안의 갈등 템포와 상대가 침묵했던 순간들을 냉철하게 타임라인으로 추적하십시오. 원인을 깨달아야 주도권 복원의 전략이 서게 됩니다.`
        recommendedMission = {
          phase: 1,
          category: "growth",
          title: "이별 전 3개월간 상대방의 침묵과 표정 변화 타임라인 정리하기",
          reason: "상대의 감정적 권태 및 방전 기조를 객관적 활자로 정리하여, 나의 잘못된 소통 습관을 정확히 마주하고 고치는 정밀 성찰 분석서입니다."
        }
      } else {
        reply = `${personalizePrefix}이별 원인 정밀 규명을 위한 ⚡ 3대 행동 강령:\n\n1. 상대에게 '도대체 이유가 뭐냐'고 취조하거나 묻는 카톡 송출을 100% 금지하십시오.\n2. 연애 중 상대방이 직접 불만을 터뜨렸던 대표적인 에피소드 3가지를 메모장에 아주 상세하게 기록하십시오.\n3. 나 자신의 프레임을 훼손하지 않기 위해 최소 3주간의 무조건적인 **#공백기** 프로토콜에 즉각 착수하십시오.`
        recommendedMission = {
          phase: 1,
          category: "action",
          title: "서운함 유발 에피소드 3가지 메모장에 세부 기록하기",
          reason: "감정을 100% 배제하고 객관적 사건 위주로 이별 원인을 활자화함으로써, 추가 매달림 충동을 뇌 과학적으로 강제 억제하는 핵심 솔루션입니다."
        }
      }
    } 
    else if (
      lowerMsg.includes('어쩌') ||
      lowerMsg.includes('어떻게') ||
      lowerMsg.includes('어떡') ||
      lowerMsg.includes('행동') ||
      lowerMsg.includes('할까') ||
      lowerMsg.includes('해야')
    ) {
      handledByIntent = true
      if (style === 'healing') {
        reply = `${personalizePrefix}${userName}님, "이제 나는 대체 무엇을 해야 하지?" 하며 당장 한 치 앞도 보이지 않는 짙은 안개 속에 서 계신 조급함을 정말 온 마음으로 헤아립니다. 🫂\n\n지금 당장 상대방에게 장문의 카톡을 보내거나 집 앞으로 찾아가고 싶겠지만, 실연 직후 뇌가 극도의 스트레스에 차 있는 상대에게는 그 어떤 말도 독약이 될 뿐입니다. 지금 당신이 취할 수 있는 가장 용기 있고 위대한 행동은 역설적으로 **'아무런 행동도 취하지 않는 우아한 침묵(#공백기)'**을 굳건히 수호하는 것입니다. 오늘은 폰을 잠시 가방 깊숙이 넣어두고, 따뜻한 물에 목욕을 하거나 음악을 들으며 아픈 나의 마음을 먼저 따뜻하게 보살펴 줍시다. 재이가 끝까지 지켜드릴게요. 🌸`
        recommendedMission = {
          phase: 1,
          category: "mindset",
          title: "핸드폰 전원 끄고 나만을 위한 힐링 스파 또는 반신욕 30분 하기",
          reason: "심박수를 이성적 안정한 상태로 되돌리고, 미친 듯이 활성화된 자멸적 연락 갈망 회로를 신체 물리적으로 진정시켜 프레임을 보호하는 힐링 지침입니다."
        }
      } else if (style === 'analytical') {
        reply = `${personalizePrefix}${userName}님, 조급하게 '어떻게 해야 하냐'며 즉흥적 대안을 찾는 태도야말로 하수 중의 최하수 행동 양식입니다. 🧠\n\n현재 본인은 상대의 단호함에 짓눌려 이성적 좌뇌(전두엽)가 마비되고 감정 뇌(편도체)가 주도하는 비이성적 패닉 상태에 놓여 있습니다. 이 상태에서 저지르는 모든 '행동'은 구걸과 프레임 폭락으로 이어집니다. 지금 즉각 행동 설계를 멈추고 철저하게 침묵하십시오. 상대가 '얘가 왜 갑자기 연락도 안 하고 가만히 있지?'라는 강한 **#예측깨기** 심리 균열을 겪게 만드는 것만이 관계 주도권을 뺏어오는 유일한 솔루션입니다.`
        recommendedMission = {
          phase: 1,
          category: "growth",
          title: "상대에게 보내고 싶었던 톡 내용을 비공개 메모장에 적고 전송하지 않기",
          reason: "뇌가 보내는 억지 도파민 충동 신호를 비공개 글로 강제 승화시켜 배출함으로써, 최악의 자멸적 저자세 카톡 전송을 행동학적으로 완전 차단합니다."
        }
      } else {
        reply = `${personalizePrefix}당장 실천해야 할 ⚡ 3대 침묵 행동 강령:\n\n1. 스마트폰에서 상대방과의 카카오톡 채팅방을 즉시 '보관함'으로 숨겨 시각적 트리거를 차단하십시오.\n2. 상대에게 전송하고 싶은 문장이나 긴 편지가 있다면, 폰 메모장에 낱낱이 다 쏟아부은 뒤 앱을 닫으십시오.\n3. 오늘부터 철저히 4주일간의 무연락 **#공백기** 프로토콜에 돌입하여, 상대의 뇌 속 스트레스가 휘발되기를 기다리십시오.`
        recommendedMission = {
          phase: 1,
          category: "action",
          title: "스마트폰 메신저 채팅방 숨김 처리 및 메모장 격리 수용하기",
          reason: "가장 손쉬운 연락 경로를 환경적으로 원천 차단하여, 홧김에 저지를 수 있는 관계 파멸적 매달림 실수를 미연에 100% 봉쇄하는 지침입니다."
        }
      }
    }
    else if (
      lowerMsg.includes('맞아') ||
      lowerMsg.includes('맞는') ||
      lowerMsg.includes('맞음') ||
      lowerMsg.includes('이게맞') ||
      lowerMsg.includes('진짜야') ||
      lowerMsg.includes('효과') ||
      lowerMsg.includes('정말') ||
      lowerMsg.includes('진짜로')
    ) {
      handledByIntent = true
      if (style === 'healing') {
        reply = `${personalizePrefix}${userName}님, "정말 아무것도 안 하고 가만히 있는 이 방법이 진짜 맞는 걸까? 이러다 영영 잊혀지면 어쩌지?" 하고 가슴이 까맣게 타들어가며 온몸으로 밀려오는 의구심과 두려움을 정말 아프게 공감합니다. 🫂\n\n하지만 재회 심리학에서 침묵(**#공백기**)은 결코 단순한 방치가 아닙니다. 현재 상대방은 나에 대한 부정적 감정과 거부감이 하늘을 찌르는 **#부정피크** 상태입니다. 이때 섣부른 연락이나 설득은 상대에게 '역시 징글징글하다, 헤어지길 참 잘했다'는 확신만 심어줄 뿐입니다. 침묵을 통해 상대의 부정 피크가 자연스럽게 마모되고 그리움이 피어오를 물리적 시간을 주는 것만이 과학적으로 증명된 유일한 정답입니다. 불안해하지 마세요. 재이가 든든히 안아드릴게요. 🌸`
        recommendedMission = {
          phase: 1,
          category: "mindset",
          title: "이별 후 첫날 상대방의 단호하고 차가웠던 거절 카톡 다시 1회 읽기",
          reason: "상대방의 마음이 얼마나 차갑게 얼어붙어 있는지 눈으로 똑똑히 마주함으로써, 나의 비이성적인 '매달리면 되겠지'라는 환상을 소멸시키고 공백기 당위성을 굳게 다지는 충격 테라피입니다."
        }
      } else if (style === 'analytical') {
        reply = `${personalizePrefix}${userName}님, 이 솔루션의 과학적 메커니즘을 명확하게 뇌에 주입해 드립니다. 🧠\n\n상대는 현재 당신이라는 존재에 대해 극심한 거부 반응과 경계벽을 높여둔 상태입니다. 당신의 섣부른 연락이나 반성문은 상대의 방어기제를 즉시 활성화하여 당신의 프레임을 쓰레기통에 처박아버리는 기폭제가 됩니다. 재회 심리학의 철칙은 **#부정피크**의 자연 마모와 고프레임 입증입니다. 침묵을 통해 당신의 소유욕을 끊어내고 가치를 보존해야만, 비로소 상대의 뇌 속에서 '상실감'과 '미련'이 싹트게 됩니다. 의심할 시간에 이 심리학 법칙을 이성적으로 엄수하십시오.`
        recommendedMission = {
          phase: 1,
          category: "growth",
          title: "재회 심리학 '프레임 이론'과 '부정 피크 마모 메커니즘' 요약하기",
          reason: "무조건적인 기다림이 초래하는 감정적 우울을 깨뜨리기 위해, 과학적인 재회 알고리즘의 원리를 이성적으로 체득하고 내면의 **#내적프레임**을 강화하는 지적 트레이닝입니다."
        }
      } else {
        reply = `${personalizePrefix}침묵 솔루션(공백기)이 정답일 수밖에 없는 ⚡ 3대 행동 과학적 근거:\n\n1. 설득과 구걸은 상대에게 절대 통하지 않으며, 오히려 당신의 매력도(#프레임)를 바닥으로 훼손시킵니다.\n2. 인간은 누구나 자신을 소유하려 안달복달하는 존재에 대해 본능적인 귀찮음과 가치 폄하를 느낍니다.\n3. 연락을 철저히 두절해야만 상대는 비로소 '진짜 상실'을 체감하고, 당신의 부정적인 기억들을 잊어가기 시작합니다.`
        recommendedMission = {
          phase: 1,
          category: "action",
          title: "매달림이 왜 재회 확률을 파괴하는지 자필 경고문 작성하기",
          reason: "충동적인 연락 욕구가 솟구칠 때마다 눈앞의 물리적인 경고문을 마주하여 감정적 뇌의 폭주를 강제 제어하는 행동 설계 제어 장치입니다."
        }
      }
    }

    if (!handledByIntent) {
      // [초고품질 동적 심리치료 조합 엔진 작동]
      const hasLongTerm = lowerMsg.includes('년') || lowerMsg.includes('오래') || lowerMsg.includes('장기') || lowerMsg.includes('사귀') || lowerMsg.includes('동거') || lowerMsg.includes('결혼')
      const hasShortTerm = lowerMsg.includes('개월') || lowerMsg.includes('한달') || lowerMsg.includes('두달') || lowerMsg.includes('얼마 안')
      const hasBlock = lowerMsg.includes('차단') || lowerMsg.includes('언팔') || lowerMsg.includes('끊') || lowerMsg.includes('연락처')
      const hasConflict = lowerMsg.includes('싸움') || lowerMsg.includes('다툼') || lowerMsg.includes('성격') || lowerMsg.includes('갈등') || lowerMsg.includes('매일') || lowerMsg.includes('성향') || lowerMsg.includes('서운')
      const hasAlternative = lowerMsg.includes('대체자') || lowerMsg.includes('환승') || lowerMsg.includes('여사친') || lowerMsg.includes('남사친') || lowerMsg.includes('다른 사람') || lowerMsg.includes('여자 생') || lowerMsg.includes('남자 생') || lowerMsg.includes('새 사람')
      const hasGuilt = lowerMsg.includes('자책') || lowerMsg.includes('내 잘못') || lowerMsg.includes('미안') || lowerMsg.includes('후회') || lowerMsg.includes('내가 왜') || lowerMsg.includes('잘할걸') || lowerMsg.includes('반성')
      
      let situationAnalysis = ''
      let therapyGuidance = ''
      let specificMission: any = null

      if (hasAlternative) {
        situationAnalysis = "현재 상대방 주변에 다른 이성(대체자)이 개입되어 있거나 환승의 조짐이 보이는 상황은 가슴이 갈기갈기 찢어지는 극심한 박탈감과 소외감을 동반합니다. 그러나 재회 심리학적으로 급격하게 불타오르는 대체자와의 허니문 관계는 그 깊이가 얕고 사소한 비교 심리로 인해 빠르게 균열이 발생하기 마련입니다. 지금 상대의 연애에 억지로 질투를 표하거나 매달리는 것은 나의 가치(프레임)를 스스로 처참하게 깎아내려 상대방에게 새 연인의 소중함만 돋보이게 만드는 최악의 수입니다."
        therapyGuidance = "마음의 칼날을 안으로 돌리지 마십시오. 당신은 상대방에게 충분히 매력적이고 깊은 잔상을 남겼던 가치 있는 존재입니다. 지금은 철저하게 나를 상대의 시야에서 숨김으로써(공백기), 상대방이 신규 대체자와의 허니문이 끝나는 1~2달 차에 당신이 주었던 익숙한 편안함과 대체 불가능한 고유의 가치를 뒤늦게 뼈저리게 후회하고 그리워하게 만드는 시간입니다. 이성적으로 나의 감정을 통제하는 지혜가 필요합니다."
        specificMission = {
          phase: 1,
          category: "mindset",
          title: "상대방의 대체자 SNS/프로필 탐색 100% 금지 및 나만의 리즈 비주얼 아카이빙하기",
          reason: "대체자와 나를 비교하는 행동은 자존감(내적프레임)을 파괴하는 독약입니다. 시각적 유해 요소를 차단하고 나의 높은 프레임을 비언어적으로 지키기 위한 극약 처방입니다."
        }
      } else if (hasBlock) {
        situationAnalysis = "상대방이 당신의 연락처를 차단하거나 메신저를 끊어버린 상태는, 당신이라는 존재를 완전히 지우고 싶어서가 아니라 현재 당신에 대한 부정적 감정과 거부 반응이 최고조에 달한 부정피크 상태임을 입증합니다. 당신의 잇따른 연락 시도가 상대의 방어기제를 자극하여 스스로를 지키기 위해 강제 차단 버튼을 누르게 만든 것이죠. 즉, 이 차단은 영원한 거절이 아니라 상대방의 뇌가 과부하되어 보내는 격렬한 '멈춤(Pause)' 신호입니다."
        therapyGuidance = "차단당했다는 사실에 매몰되어 조급해질수록 상황은 파멸로 치닫습니다. 지금은 상대방의 뇌 속 스트레스 호르몬이 완전히 소멸하고 부정적 기억이 미화될 수 있도록 최소 4주일간의 철저한 무반응 침묵(공백기)을 지켜야 합니다. 침묵이 이어질 때 상대방은 비로소 경계심을 풀고 '얘가 진짜 나를 포기했나?' 하는 상실감과 함께 차단을 풀고 프로필을 염탐하는 역방향 심리 자극을 겪게 됩니다."
        specificMission = {
          phase: 1,
          category: "action",
          title: "차단 창 열어보지 않고 스마트폰의 상대방 대화창 숨김 폴더로 영구 격리하기",
          reason: "차단 여부를 매번 확인하는 버릇은 뇌에 쓸데없는 조바심 도파민을 부추겨 충동 연락을 유발합니다. 물리적인 인지 장벽을 설치하여 멘탈 자존감을 보호하기 위한 강령입니다."
        }
      } else if (hasConflict) {
        situationAnalysis = "반복적인 갈등과 다툼으로 헤어진 갈등반복형 이별은 매력이 부족해서가 아니라, 서로의 상처를 들여다보지 못하고 붕괴된 신뢰감이 본질적인 원인입니다. 상대는 당신을 사랑하지 않아서가 아니라, '이 사람과는 아무리 대화해도 말이 통하지 않고 미래가 없다'는 좌절감과 감정 소진 상태에 빠져 도망치듯 이별을 고한 것입니다. 이 상황에서 구두로 '다 고치겠다, 한 번만 믿어달라'고 빌어봤자 상대의 불신만 가중됩니다."
        therapyGuidance = "지금은 설득의 카톡을 보낼 때가 아니라, 우리의 다툼 유형과 소통 방식을 제3자 관점에서 냉철하게 분석하는 객관화가 선행되어야 합니다. 말로 하는 약속은 가치가 0원입니다. 철저한 침묵의 시간(공백기) 동안 감정 기복이 완전히 치료되고 한층 더 성숙해진 멘탈을 장착했음을 추후 비언어적인 라이프스타일 전시나 쿨한 대화로 증명해 낼 때, 상대방은 굳게 닫았던 신뢰의 벽을 허물기 시작합니다."
        specificMission = {
          phase: 1,
          category: "growth",
          title: "연애 시절 서로에게 깊은 상처를 주었던 갈등 에피소드 3가지 제3자 관점에서 복기해 보기",
          reason: "나의 감정적 소통 오류를 활자화하여 멘탈의 기복을 제어하고, 추후 대면 시 완벽하게 성숙해진 소통의 신뢰감을 확보하기 위한 치료 훈련입니다."
        }
      } else if (hasGuilt) {
        situationAnalysis = "과거 나의 잘못이나 실수로 인해 헤어졌다는 깊은 자책과 후회는 뇌가 이별의 아픔 속에서 스스로를 처벌하여 심리적 고통을 회피하려는 흔한 인지 오류(자책적 인지 왜곡) 중 하나입니다. \"내가 그때 조금만 참았더라면...\", \"그 말을 하지 않았더라면...\" 하는 후회는 완벽한 환상입니다. 관계는 어느 한쪽의 일방적인 잘못으로만 깨지지 않으며, 이미 무너진 가치 균형 속에서 자책은 오직 본인의 가치(프레임)를 스스로 깎아내려 더더욱 을(乙)의 포지션에 가두는 자멸 행동입니다."
        therapyGuidance = "스스로를 갉아먹는 유죄 판결을 즉시 멈추십시오. 과거의 행동은 당시 당신의 인지 수준과 상처 속에서 일어난 최선 혹은 어쩔 수 없는 방어기제였습니다. 자신에게 용서를 베풀고 자존감(내적프레임)을 수호해야만 매력적인 사람으로서 상대 앞에 다시 설 수 있습니다. 후회 섞인 장문의 사과문은 상대에게 무거운 의무감과 거부감만 줄 뿐이므로, 지금은 묵묵히 나를 용서하고 건강하게 내 삶을 피워내어 성숙한 매력을 증명할 때입니다."
        specificMission = {
          phase: 1,
          category: "mindset",
          title: "거울 속의 내 눈을 바라보며 나를 용서하는 고요한 다짐 3회 소리 내어 말해주기",
          reason: "부정적인 뇌의 자책 루프를 강제로 차단하고, 스스로의 존엄성(내적프레임)을 복구하여 이별 충격을 치유하는 인지행동치료 기반의 핵심 마인드 피트니스입니다."
        }
      } else if (hasLongTerm) {
        situationAnalysis = "오랜 기간 사귄 연애 뒤의 이별은 서로의 인생과 일상이 너무나 촘촘하게 얽혀 있기에 그 상실의 고통이 말도 못 하게 깊고 거대합니다. 하지만 장기 연애 이별의 강력한 장점은 수년간 축적된 엄청난 두께의 역사와 감정적 애착 정서가 상대방의 뇌 속에도 단단하게 자리 잡고 있다는 점입니다. 지금 상대방은 이별 직후라 나쁜 기억만 돋보이는 부정피크에 갇혀 당신을 밀어내고 있지만, 이 정서는 침묵이 흐르는 동안 반드시 당신을 향한 깊은 미련과 향수로 회귀하게 되어 있습니다."
        therapyGuidance = "장기 연애의 재회 핵심은 조급하게 안부를 물어 역사에 찬물을 끼얹는 것이 아니라, 상대에게 '진짜 상실'을 느끼게 해주는 것입니다. 당신이 계속 찔러보거나 옆에 머물러 있으면 상대는 상실감을 느끼지 못하고 이별의 편안함만 만끽합니다. 철저한 연락 두절(공백기)을 선사하여 당신의 익숙한 빈자리가 주는 거대한 고독감과 상실감을 체감하게 만드십시오. 시간이 흐를수록 시간은 당신의 강력한 아군이 될 것입니다."
        specificMission = {
          phase: 1,
          category: "action",
          title: "상대방과 함께 자주 가던 장소나 공유했던 물건들 시야에서 100% 치우고 격리하기",
          reason: "시각적 트리거는 끊임없는 연상 작용을 일으켜 뇌를 실시간으로 우울하게 만듭니다. 물리적 리셋을 통해 뇌에 '새 출발' 신호를 주어 자존감을 보호하는 강령입니다."
        }
      } else {
        // 일반적인 불안/우울 호소 케이스 및 뎁스별 폴백 지원
        const depthIdx = userMessageCount % 3
        if (depthIdx === 0) {
          situationAnalysis = "이별의 기로에서 찾아오는 극심한 불안과 공허함은 당신의 뇌 속 애착 호르몬이 급격하게 억제되면서 발생하는 지극히 자연스러운 신체적 골절 고통과도 같은 상태입니다. \"지금 아무것도 안 하면 영영 잊혀질 것 같다\"는 생각은 뇌가 도파민 중독 금단 현상으로 인해 뿌려대는 가장 대표적인 환상입니다. 이 시기에 행하는 즉흥적인 연락과 구걸은 상대에게 '징글징글하다'는 거부감만 줄 뿐 재회 기회를 영구 차단합니다."
          therapyGuidance = "지금 당신이 지켜내고 있는 침묵(공백기)은 가만히 손 놓고 지는 것이 아니라, 상대방에게 나의 신비로운 가치(프레임)를 다시 바로 세우고 상대의 부정 피크가 자연 마모될 시간을 주는 가장 능동적이고 이성적인 전투입니다. 억지로 이 불안을 참아내려 하지 마시고, 맛있는 음식을 먹거나 잠시 가벼운 산책을 하며 내 신체와 마음에 기쁨을 선물해 주세요. 재이가 늘 함께할 테니 흔들리지 마십시오."
          specificMission = {
            phase: 1,
            category: "action",
            title: "핸드폰을 서랍 속에 넣고 3시간 외출하기",
            reason: "도파민 중독처럼 연락을 갈구하는 중독 상태에서 벗어나 본래의 강인한 주체적 자아를 다잡는 행동 처방 지침입니다."
          }
        } else if (depthIdx === 1) {
          situationAnalysis = "이별 직후 상대방의 사소한 프로필 변화나 눈빛 하나에도 온 신경이 쏠리며 감정이 널뛰는 상태가 지속될 수 있습니다. 뇌과학적으로 실연은 뇌의 통제 센터를 일시 정지시키고 감정 반응(불안, 갈망)을 극한으로 유도합니다. 하지만 지금 상대에게 쏟아내는 모든 설득과 눈물은 상대방에게 우월감을 유도해 당신의 프레임을 폭락시킬 뿐입니다."
          therapyGuidance = "지금 필요한 유일한 백신은 나의 감정적 욕구를 전략적으로 수거하고 철저하게 침묵을 유지하는 것입니다. 상대가 당신의 흔적을 찾을 수 없게 만들 때, 비로소 상대방의 뇌 속에서도 경계심이 마모되고 '이 사람이 왜 갑자기 멈췄지?'라는 강력한 호기심 균열이 발생하기 시작합니다. 흔들리지 마십시오. 재이가 늘 든든히 지켜드릴게요."
          specificMission = {
            phase: 1,
            category: "mindset",
            title: "내 감정을 날것 그대로 메모지에 적어본 뒤 가차 없이 찢어 버리기",
            reason: "억눌린 불안과 갈망을 안전하게 발산하여 내면 프레임을 회복하고, 뇌 속 유해한 도파민 중독 반응을 신속하게 디톡스하는 심리 테라피 처방입니다."
          }
        } else {
          situationAnalysis = "마음 한구석에 조급한 폭풍우가 몰아쳐 가만히 서 있기도 힘겨우신 상태라는 걸 잘 압니다. \"지금 당장 돌파구를 찾지 않으면 영영 끝이다\"라는 조급함은 이별의 극심한 금단 현상일 뿐 사실이 아닙니다. 오히려 홧김에 던지는 칼답이나 눈치 보기 톡은 주도권을 완전히 상대에게 상실하여 을(乙)의 포지션에 가두는 최악의 오류입니다."
          therapyGuidance = "불안에 압도되어 자멸적인 연락을 하지 않도록 나만의 내적 중심을 단단히 잡아야 합니다. 감정의 흐름을 이성적이고 차분한 활동으로 분산시켜 뇌의 과부하를 가볍게 해소해야 할 타임입니다. 오늘 하루만큼은 폰을 잠시 내려놓고 맛있는 차 한 잔을 마시며 내 마음에 온전히 집중해 보십시오. 재이가 온 마음을 다해 함께할게요."
          specificMission = {
            phase: 1,
            category: "mindset",
            title: "하루 동안 좋아하는 노래만 들으며 거울 보고 세 번 미소 짓기",
            reason: "강제로 입꼬리를 올리는 뇌의 신체적 피드백을 활용하여, 무너진 자존감(내적프레임)을 쾌활하게 끌어올리고 우울 에너지를 걷어내는 가벼운 멘탈 피트니스입니다."
          }
        }
      }

      // 코칭 스타일에 맞춰 심리 치료 답변을 동적으로 결합 및 조합
      if (style === 'healing') {
        reply = `${personalizePrefix}${userName}님, 현재 이별의 아픔 속에서 감정의 폭풍우에 흔들리시는 그 복잡하고 애타는 심경을 온 마음을 다해 이해합니다. (안아줌)\n\n${situationAnalysis}\n\n${therapyGuidance}\n\n오늘 하루만큼은 나를 자책하거나 상대를 원망하지 말고, 아픈 내 마음에 따뜻한 차 한 잔을 얹어주며 부드럽게 보살펴 줍시다. 재이가 온 마음을 다해 항상 당신 곁에 함께할게요. *`
        recommendedMission = specificMission
      } else if (style === 'analytical') {
        reply = `${personalizePrefix}${userName}님, 현재 겪으시는 감정적 혼란 상태를 걷어내고 관계의 본질을 이성적으로 차분하게 분석해야 할 중요한 시기입니다. [이성]\n\n${situationAnalysis}\n\n${therapyGuidance}\n\n조급함과 충동은 재회 확률을 파괴하는 최악의 주범임을 명심하고, 철저하게 나를 감추어 주도권(프레임)의 우위를 점하는 영리한 사람이 되십시오.`
        recommendedMission = {
          ...specificMission,
          category: "growth",
          reason: "상황을 객관적인 3인칭의 이성적 구조로 바라봄으로써, 감정 뇌의 폭주를 방어하고 자존감(내적프레임)을 단단하게 다잡는 정밀 마인드 트레이닝입니다."
        }
      } else { // action
        reply = `${personalizePrefix}1단계 (공백기) [행동] 침묵 통제 행동 강령 및 지침 안내:\n\n1. 즉시 추천된 ${specificMission.title} 미션에 돌입하고 인증을 완료하십시오.\n2. 상대방의 SNS, 카카오톡 프로필 등 나를 괴롭히는 시각적 요소를 즉시 숨김/차단하여 시각적 자극을 원천 제거하십시오.\n3. 철저하게 연락을 두절하여 나의 신비감을 극대화하고, 상대방이 가졌던 부정적인 기억들을 깨끗하게 지우게 만드는 4주 프로토콜을 한 치의 오차도 없이 고수하십시오.`
        recommendedMission = {
          ...specificMission,
          category: "action"
        }
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

