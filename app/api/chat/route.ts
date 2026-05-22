import { buildSystemPrompt, phaseFromDays, type UserContext } from '@/lib/ai-system-prompt'
import { createSupabaseServer } from '@/lib/supabase/server'

// Gemini 모델 (무료 티어 할당량 이슈 우회를 위해 flash-latest 사용)
const AI_MODEL = process.env.GEMMA_MODEL_ID || 'gemini-flash-latest'

interface GeminiMessage {
  role: 'user' | 'model'
  parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>
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

    // 서버 컨텍스트 머지: 로그인 사용자는 profiles 우선, 비로그인은 클라 값 그대로
    const userContext = await resolveUserContext(clientContext)
    const systemPrompt = buildSystemPrompt(userContext)

    // 로컬 개발 환경 강제 또는 API Key 누락 시 즉각 로컬/Mock AI로 우회
    if (process.env.USE_LOCAL_AI === 'true' || !apiKey) {
      console.warn('[chat] Using local/mock AI fallback due to configuration or missing API Key.')
      return runLocalOrMockAI(messages, userContext)
    }

    const contents: GeminiMessage[] = messages.map((m, idx) => {
      const isLastUserMessage = idx === messages.length - 1 && m.role === 'user'
      const parts: GeminiMessage['parts'] = [{ text: m.content || '(내용 없음)' }]
      if (isLastUserMessage && image) {
        parts.push({ inline_data: { mime_type: image.mimeType, data: image.data } })
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
      return runLocalOrMockAI(messages, userContext)
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
      return runLocalOrMockAI(messages, userContext)
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
  userContext: UserContext
): Promise<Response> {
  const OLLAMA_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434/api/chat'
  
  try {
    // 500ms timeout을 주어 Ollama 서버 연결을 조기 타임아웃하여 지연 차단
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 500)
    
    const checkRes = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_MODEL || 'gemma2',
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
          model: process.env.OLLAMA_MODEL || 'gemma2',
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
      }
    }
  } catch (err) {
    console.log('[Ollama] Local server connection failed or unavailable. Falling back to Mock AI...')
  }

  // 최종 Fallback: 초고품질 Mock AI 스트리밍 엔진 작동
  console.log('[Mock AI] Connection failed or bypassed. Streaming high-quality psychological mock response...')
  return generateMockAIResponse(messages, userContext)
}

/**
 * 재회심리학 지침 기반 고품질 Mock AI 스트리밍 엔진
 */
function generateMockAIResponse(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  userContext: UserContext
): Response {
  const lastUserMsg = messages[messages.length - 1]?.content || ''
  const phase = userContext.currentPhase || 1
  const type = userContext.breakupType || 'A'
  const userName = userContext.userName || '재회 희망자'

  let reply = ''
  let recommendedMission: any = null

  // 1. 키워드 기반 정밀 매칭
  if (lastUserMsg.includes('연락') || lastUserMsg.includes('카톡') || lastUserMsg.includes('문자') || lastUserMsg.includes('전화')) {
    if (phase === 1) {
      reply = `${userName}님, 지금 먼저 연락하고 싶은 마음에 심장이 조여오고 하루에도 수십 번씩 휴대폰을 열어보시는 그 심정, 정말 아프도록 깊이 공감합니다. 😭\n\n하지만 재회심리학 관점에서 볼 때, 지금 취하는 먼저 연락은 오히려 남아있는 재회 가능성마저 산산조각 내는 치명적인 독약이 될 수 있습니다.\n\n현재 상대방은 당신에 대한 부정적인 감정(권태감, 분노, 피로)이 극에 달해 당신을 밀어내고 싶어 하는 **#부정피크** 상태입니다. 이때 감정적으로 매달리거나 안부를 묻는 카톡은 당신의 이성적 매력(#프레임)을 바닥까지 팽개치는 최악의 저자세 행동입니다.\n\n가장 강력한 카드는 당신이 우아하고 완벽하게 상대의 시야에서 사라져 주는 **#공백기(No Contact)**입니다. 상대방의 뇌가 당신에 대해 쌓아 둔 나쁜 감정들을 지우고 그리움을 촉발시킬 수 있도록 철저한 침묵을 고수하세요.`
      recommendedMission = {
        phase: 1,
        category: "action",
        title: "카톡 프로필 기본 이미지로 변경하기",
        reason: "갑작스러운 프로필 초기화는 상대방의 호기심과 상실감을 극대화하며, 당신의 내면 심리를 읽을 수 없도록 가림막을 쳐서 당신의 가치(#프레임)를 회복하는 강력한 이별 처방전입니다."
      }
    } else if (phase === 2) {
      reply = `${userName}님, 공백기를 성실하게 채우시고 연락 타이밍을 조율하고 계시네요. 하지만 직접 다가가 문을 두드리기보단, 간접적으로 당신의 변화를 노출하는 **#자기전시** 전략이 10배 더 안전하고 강력합니다.\n\n다짜고짜 연락이 가면 상대방은 즉시 방어벽을 세우지만, 카톡 프로필이나 SNS를 통해 성숙해진 외모, 건강한 취미, 혹은 예전과 달라진 열정적인 모습을 슬쩍 흘려주는 것은 아무런 거부감 없이 호기심을 폭발시킵니다.\n\n당신의 삶이 이별 후 한층 더 풍요로워졌음을 전시하여 상대가 먼저 당신을 떠올리게 하세요.`
      recommendedMission = {
        phase: 2,
        category: "growth",
        title: "새로운 관심사에 관한 책 1권 읽고 짧은 감상 남기기",
        reason: "성장하고 차분해진 모습을 프로필 등에 전시하면 가벼운 이성이 아닌 성숙한 어른으로서의 매력을 어필하여 무너진 **#신뢰감** 을 단단히 복원할 수 있습니다."
      }
    } else {
      reply = `${userName}님, 마침내 본격적인 재회 접근 단계인 **#재접근기(PHASE 3)** 에 당도하셨군요! 이 단계에서의 첫 터치(연락)는 절대로 감정적이어서는 안 됩니다. '보고 싶었다'라거나 '우리가 왜 헤어졌는지 생각했다'는 식의 대화는 즉각적인 차단으로 이어집니다.\n\n첫 연락은 오직 상대가 부담 없이 대답할 수 있고, 대답해야만 하는 **지극히 가볍고 실용적인 질문**이어야만 합니다.\n\n예를 들어 '예전에 같이 주문했던 강아지 간식 사이트 주소 기억나?' 혹은 '네가 쓰던 노트북 거치대 브랜드 이름이 뭐였지?' 처럼 감정을 철저히 배제한 건조한 어조로 던지십시오. 답장이 오면 쿨하게 고맙다고 말하고 대화를 바로 마무리지어 오히려 묘한 여운을 남기세요.`
      recommendedMission = {
        phase: 3,
        category: "action",
        title: "상대방의 방어기제를 자극하지 않는 첫 연락 카톡 멘트 설계",
        reason: "감정을 1%도 담지 않은 실용적 질문 멘트를 완벽히 다듬어 답장 성공률을 극적으로 높이는 트레이닝입니다."
      }
    }
  } else if (lastUserMsg.includes('힘들') || lastUserMsg.includes('아프') || lastUserMsg.includes('슬프') || lastUserMsg.includes('불안') || lastUserMsg.includes('미치')) {
    reply = `지금 가슴이 타들어 가고 호흡조차 가빠지는 듯한 극심한 고통 속에 서 계시는군요. 마음이 깊이 쓰입니다. 🫂\n\n신경심리학적으로 밝혀진 사실은 실연의 고통이 실제 뼈가 바스러지는 신체적 부상과 동일한 뇌 영역(전방 대상피질)에서 고통 신호로 감지된다는 것입니다. 즉, 당신의 뇌는 지금 커다란 상처를 입고 피를 흘리는 비상 상태인 것입니다.\n\n불안에 지배되어 충동적으로 연락함으로써 이 고통을 모면하려 하지 마세요. 그것은 상처를 돌보지 않고 마약성 진통제를 투여받는 것과 다르지 않습니다.\n\n지금 가장 필요한 것은 당신 스스로의 **#신뢰감** 과 흔들리지 않는 중심을 세우는 멘탈 복구입니다. 따뜻한 음료를 마시고, 이 감정을 억누르는 대신 한바탕 글로 시원하게 쏟아내 보며 불안의 고리를 끊어내십시오. 재이가 당신의 방파제가 되어 드리겠습니다.`
    recommendedMission = {
      phase: 1,
      category: "mindset",
      title: "매일 저녁 10분 감사 일기 적기",
      reason: "갈팡질팡하는 이별 우울증에서 뇌의 편도체를 안정시키고 건강한 자존감을 회복하도록 돕는 인지 행동 치료 기반의 필수 미션입니다."
    }
  } else if (lastUserMsg.includes('이유') || lastUserMsg.includes('왜') || lastUserMsg.includes('원인') || lastUserMsg.includes('진단')) {
    if (type === 'A') {
      reply = `${userName}님이 진단받으신 **감정소진형 (Type A)** 이별의 원인은, 오랜 다툼이나 무리한 애정 테스트, 서운함 폭발 등으로 인해 당신이 가진 이성적 매력(#프레임)이 완전히 다 닳아 소진되었기 때문입니다.\n\n상대는 당신을 사랑했으나 끊임없이 서운함을 해소해 주다가 정신적으로 완전히 번아웃 상태에 이르렀고, 스스로의 생존을 위해 도망치듯 이별을 고한 것입니다.\n\n여기서 자꾸 매달리거나 편지를 건네는 것은 상대에게 더 극심한 질림과 소진을 부릅니다. 지금 당장 모든 에너지를 회수하고 완전한 침묵으로 물러나 당신의 소중했던 고프레임을 재충전하는 **#공백기**를 절대적으로 엄수하셔야 합니다.`
      recommendedMission = {
        phase: 1,
        category: "action",
        title: "상대방의 SNS 및 프로필 업데이트 확인 중단하기",
        reason: "상대의 상태를 스토킹하듯 확인하는 버릇은 당신의 가치를 저자세로 가두어 회생을 방해합니다. 확실한 감시 단절을 통해 마음의 독립을 이룩하세요."
      }
    } else if (type === 'B') {
      reply = `${userName}님이 처한 **갈등반복형 (Type B)** 이별의 본질은 매력도(프레임)의 부족이 아닌, 관계의 근간인 **#신뢰감** 이 훼손되었기 때문입니다.\n\n성격 차이나 가치관 차이로 싸움이 쳇바퀴 돌듯 반복되면서, 상대는 '우리는 정말 말이 통하지 않는구나', '앞으로도 나아지지 않겠구나' 하는 관계의 종식을 통감한 상태입니다.\n\n단순히 '내가 다 잘못했다'며 빌거나 각서를 쓰는 식의 접근은 전혀 신뢰가 가질 않습니다. 본인의 감정 기복과 갈등 해결 패러다임을 한 단계 성숙하게 가다듬고, 성찰한 내면을 간접적으로 증명하는 대대적인 변화 혁신이 절실합니다.`
      recommendedMission = {
        phase: 2,
        category: "growth",
        title: "대화/갈등 조율 전문 도서 1권 읽고 마스터 플랜 수립",
        reason: "관계를 안정적으로 이끌어갈 수 있는 진정성 어린 **#신뢰감**을 확보하여 추후 대면 시 확 달라진 기류를 안겨주는 고품격 미션입니다."
      }
    } else if (type === 'C') {
      reply = `${userName}님이 가슴 아파하시는 **대체자형 (Type C)** 이별은 상대에게 매력적인 다른 대안(신규 대체자)이 생겨나면서 당신의 영역을 이탈한 뼈아픈 이별입니다.\n\n현재 상대는 새로운 만남이 주는 쾌락 호르몬에 취해 있어, 당신의 어떠한 비난이나 설득도 철벽처럼 튕겨 나갈 것입니다. 그러나 결코 포기하거나 절망하지 마십시오.\n\n날림으로 불타오른 관계는 속이 비어 있어 사소한 오해로도 쉽게 균열이 갑니다. 이때 당신이 묵묵하고 격조 높게 **#프레임** 을 지키며 가만히 있어 줄 때, 상대는 새 연인과 싸울 때마다 변치 않았던 당신 고유의 고결한 가치를 떠올리며 걷잡을 수 없는 후폭풍을 맞이하게 됩니다. 침묵이 가장 무서운 기습입니다.`
      recommendedMission = {
        phase: 1,
        category: "mindset",
        title: "전문 스튜디오에서 인생 단독 컷 촬영 후 은연중 노출",
        reason: "새로 만나는 대체자보다 당신이 비교할 수 없을 만큼 멋지고 세련된 파트너였음을 시각적으로 일깨워 상대의 마음에 강력한 균열을 냅니다."
      }
    } else {
      reply = `${userName}님이 겪으신 **장기이별형 (Type D)** 은 헤어진 후 오랜 세월이 흘렀거나 현실적인 장벽에 밀려 서서히 멀어진 형태입니다.\n\n시간이라는 훌륭한 망각제 덕분에 상대의 머릿속에 가득했던 부정적인 기억들은 깨끗이 휘발되고, 아련하고 애틋한 미화된 기억만 은은하게 남아있습니다. 즉, 당신은 새 도화지를 얻으신 것입니다.\n\n이 유형의 필승 전략은 옛날 연인 행세를 하지 않고, **'완전히 새로운 낯선 이성'**으로 다가가는 것입니다. 스타일이나 분위기를 완전히 새롭게 체질 개선(#자기전시)한 뒤 가볍고 상큼하게 상대의 인생에 틈입해야 합니다.`
      recommendedMission = {
        phase: 2,
        category: "growth",
        title: "퍼스널 스타일링 및 이미지 메이킹 180도 체인지",
        reason: "오래된 기억 속의 평범하고 익숙한 이미지를 타파하고 매력적인 이성으로서의 신선한 프레임을 다시 세우는 최상의 솔루션입니다."
      }
    }
  } else {
    // 2. 일반 기본 조언 (PHASE 별 분기)
    if (phase === 1) {
      reply = `${userName}님, 재이를 신뢰해 주셔서 대단히 감사합니다. 🫂\n\n진단 내용에 근거한 현재 단계는 **PHASE 1 (공백기)** 입니다. 이 단계의 첫 번째 계율은 바로 **'침묵 속의 프레임 복구'**입니다.\n\n실연 후에는 자극에 굶주린 뇌가 충동적인 카톡을 보내라고 성화를 부리지만, 상대의 뇌 속에 머무는 나쁜 기억들이 말끔히 가라앉고 당신의 가치가 다시 고프레임으로 살아나기 위해서는 절대적으로 **#공백기(No Contact)**가 완수되어야 합니다.\n\n오늘은 그 어떤 시도도 멈춘 채, 자신에게 따뜻하고 깊은 휴식을 선물하세요. 재이가 밤하늘의 나침반처럼 당신을 인도하겠습니다.`
      recommendedMission = {
        phase: 1,
        category: "action",
        title: "핸드폰을 서랍 속에 넣고 3시간 외출하기",
        reason: "도파민 중독처럼 연락을 갈구하는 중독 상태에서 벗어나 본래의 강인한 주체적 자아를 다잡는 행동 처방 지침입니다."
      }
    } else if (phase === 2) {
      reply = `${userName}님, 다시 뵙게 되어 무척 반갑습니다. 🌱 현재는 도약을 준비하는 **PHASE 2 (자기계발기)** 영역을 순항 중이십니다.\n\n훌륭한 공백기 수호 덕분에 상대의 강했던 경계심과 부정적 인상들은 차분하게 가라앉았습니다. 이제는 당신이 얼마나 성장하고 매력적인 파트너로 진화했는지를 입증할 타임입니다.\n\n자신의 건강한 루틴, 새로운 취미, 세련되게 정리된 일상의 전각들을 프로필 등을 통해 차분히 전시하는 **#자기전시** 전략이 중심이 됩니다. 빛나는 사람에게는 자연스럽게 이성이 끌리기 마련입니다.`
      recommendedMission = {
        phase: 2,
        category: "growth",
        title: "피트니스 또는 운동 루틴 1주일 유지 기록 인증",
        reason: "신체적인 활성화는 우울한 멘탈을 굳세게 해줄 뿐만 아니라, 비주얼적으로 최고로 고양된 프레임을 상대에게 어필할 수 있는 최상의 디딤돌입니다."
      }
    } else {
      reply = `눈부신 여정을 거쳐 관계 성취를 눈앞에 둔 **PHASE 3 (재접근기)** 에 골인하셨네요! 대단하십니다. 💫\n\n이 시기는 성실히 가다듬은 당신의 완벽한 쇄신안을 은연중에 보여줄 기회입니다. 다짜고짜 문을 부수듯 들어서지 마시고, 아주 가볍고 유쾌한 **간보기 전략**으로 상대방의 심리적 문턱을 정찰해야 합니다.\n\n감정이 덕덕히 묻어나는 장문이나 사과 카톡은 패착입니다. 공적이거나 대답이 매우 용이한 한 줄 카톡으로 상대의 반응 기류를 파악하세요. 답장이 오면 내용을 캡처해서 저에게 들고 오시면 철저하게 전략 코칭을 이어 가겠습니다!`
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
      function pushNextCharacter() {
        if (currentPos < chunkText.length) {
          const chunk = chunkText.slice(currentPos, currentPos + 4)
          controller.enqueue(encoder.encode(chunk))
          currentPos += 4
          setTimeout(pushNextCharacter, 20)
        } else {
          // 텍스트 스트리밍 종료 직후 미션 추천 노드 주입
          if (recommendedMission) {
            const missionTag = `\n\n<mission_recommend>\n${JSON.stringify(recommendedMission, null, 2)}\n</mission_recommend>`
            controller.enqueue(encoder.encode(missionTag))
          }
          controller.close()
        }
      }
      pushNextCharacter()
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

