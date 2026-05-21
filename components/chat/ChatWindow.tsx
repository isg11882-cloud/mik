'use client'

/**
 * ChatWindow — 재회 전문가 AI 상담 채팅 컴포넌트
 * 스트리밍 응답, 미션 추천 파싱, 대화 히스토리 관리
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import type { UserContext } from '@/lib/ai-system-prompt'
import { useAppStore } from '@/lib/store'
import { clsx } from 'clsx'
import LoginPromptModal from '@/components/auth/LoginPromptModal'

// 로그인 프롬프트 쿨다운(24시간)
const LOGIN_PROMPT_COOLDOWN_MS = 24 * 60 * 60 * 1000
// 로그인 프롬프트 트리거 임계값(메시지 개수 — 약 5턴)
const LOGIN_PROMPT_MESSAGE_THRESHOLD = 10

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  isError?: boolean
  timestamp?: number
  missionRecommend?: {
    phase: number
    category: string
    title: string
    reason: string
  }
}

interface ChatWindowProps {
  userContext: UserContext
  initialMessage?: string
}

// 미션 추천 태그 파싱 (더 유연한 정규식)
function parseMissionRecommend(text: string) {
  const match = text.match(/<?mission_recommend>([\s\S]*?)(?:<\/mission_recommend>|$)/)
  if (!match) return null
  try {
    return JSON.parse(match[1].trim())
  } catch {
    return null
  }
}

// AI 추천 미션의 안정적 ID 생성 (제목 기반 슬러그)
// - 같은 제목의 추천이 여러 번 떠도 같은 ID로 매핑되어 중복 시작/완료를 방지
function dynamicMissionId(title: string) {
  const normalized = title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '') // 한글/영숫자/하이픈만 유지
    .slice(0, 60)
  return `dynamic-${normalized || 'mission'}`
}

function cleanContent(text: string) {
  return text.replace(/<?mission_recommend>[\s\S]*?(?:<\/mission_recommend>|$)/g, '').trim()
}

// 해시태그(#이론명) 강조 렌더링
function formatContent(text: string) {
  if (!text) return null
  const parts = text.split(/(#[가-힣a-zA-Z0-9]+)/g)
  return parts.map((part, i) => {
    if (part.startsWith('#')) {
      return (
        <span key={i} className="px-1.5 py-0.5 rounded-md bg-blue-500/20 text-blue-300 font-bold border border-blue-500/30 mx-0.5 inline-block text-[0.8em]">
          {part}
        </span>
      )
    }
    return part
  })
}

// 빠른 답변 버튼 목록 (컨텍스트별)
const QUICK_REPLIES: Record<number, string[]> = {
  1: [
    '오늘 연락하고 싶어서 너무 힘들어요',
    '상대 SNS를 계속 보게 돼요',
    '이별 원인을 정확히 모르겠어요',
    '무연락을 얼마나 해야 할까요?',
  ],
  2: [
    '어떤 변화부터 시작하면 좋을까요?',
    '헬스를 시작했어요, 다음은 뭘 할까요?',
    'SNS에 뭘 올리면 효과적일까요?',
    '자기계발 동기가 안 생겨요',
  ],
  3: [
    '첫 연락 어떻게 하면 좋을까요?',
    '상대가 답장을 했어요!',
    '만남을 제안하고 싶은데 어떻게 할까요?',
    '상대 반응이 애매해요, 분석해줘요',
  ],
}

export default function ChatWindow({ userContext, initialMessage }: ChatWindowProps) {
  const router = useRouter()
  const [input, setInput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [errorState, setErrorState] = useState<string | null>(null)
  const [selectedImage, setSelectedImage] = useState<{ file: File; preview: string } | null>(null)
  
  const {
    user,
    chatHistory,
    setChatHistory,
    activeMissions,
    startMission,
    isMissionActiveByTitle,
    isMissionCompletedByTitle,
    lastLoginPromptedAt,
  } = useAppStore()

  // 초기 메시지 설정 (저장된 내역이 있으면 그것을 사용, 없으면 빈 배열로 시작하여 useEffect에서 처리)
  const [messages, setMessages] = useState<Message[]>(chatHistory.length > 0 ? chatHistory : [])
  const [showLoginPrompt, setShowLoginPrompt] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 메시지 변경 시 스토어에 동기화
  useEffect(() => {
    if (messages.length > 0) {
      setChatHistory(messages)
    }
  }, [messages, setChatHistory])

  useEffect(() => {
    // 저장된 대화가 없을 때만 초기 메시지 설정
    if (chatHistory.length === 0) {
      if (initialMessage) {
        setMessages([
          { id: 'welcome', role: 'assistant', content: initialMessage, timestamp: Date.now() }
        ])
      } else {
        const welcome = getWelcomeMessage(userContext)
        setMessages([
          { id: 'welcome', role: 'assistant', content: welcome, timestamp: Date.now() }
        ])
      }
    }
  }, [initialMessage, userContext, chatHistory.length])

  // 자동 스크롤 (메시지가 추가되거나 스트리밍 중일 때 최하단으로 이동)
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [messages, isStreaming])

  // 로그인 프롬프트: 비로그인 + 메시지 N개 누적 + 24h 쿨다운 통과 시 1회 노출
  useEffect(() => {
    if (user) return
    if (isStreaming) return
    if (messages.length < LOGIN_PROMPT_MESSAGE_THRESHOLD) return

    const lastTs = lastLoginPromptedAt ? new Date(lastLoginPromptedAt).getTime() : 0
    const elapsed = Date.now() - lastTs
    if (elapsed < LOGIN_PROMPT_COOLDOWN_MS) return

    setShowLoginPrompt(true)
  }, [user, isStreaming, messages.length, lastLoginPromptedAt])

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const preview = URL.createObjectURL(file)
      setSelectedImage({ file, preview })
    }
  }

  const sendMessage = useCallback(async (text: string) => {
    if ((!text.trim() && !selectedImage) || isStreaming) return

    const userMsg: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text.trim() || (selectedImage ? '이미지를 확인해 주세요.' : ''),
      timestamp: Date.now(),
    }

    const historyForAPI = messages
      .filter(m => m.id !== 'welcome')
      .map(m => ({ role: m.role, content: m.content }))

    setMessages(prev => [...prev, userMsg])
    setInput('')
    setIsStreaming(true)
    setErrorState(null)

    // 이미지 파일 처리 (base64)
    let imageData = null
    if (selectedImage) {
      try {
        const file = selectedImage.file
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve((reader.result as string).split(',')[1])
          reader.onerror = reject
          reader.readAsDataURL(file)
        })
        imageData = { mimeType: file.type, data: base64 }
        setSelectedImage(null)
      } catch (e) {
        console.error('Image processing failed:', e)
      }
    }

    // AI 응답 placeholder
    const aiMsgId = (Date.now() + 1).toString()
    const aiMsg: Message = {
      id: aiMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    }
    setMessages(prev => [...prev, aiMsg])

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...historyForAPI, { role: 'user', content: userMsg.content }],
          userContext,
          image: imageData,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        throw new Error(errorData.detail || 'API error')
      }
      if (!response.body) throw new Error('No response body from server')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let fullText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fullText += decoder.decode(value, { stream: true })

        // 실시간 렌더링
        const mission = parseMissionRecommend(fullText)
        const cleanText = cleanContent(fullText)
        setMessages(prev =>
          prev.map(m =>
            m.id === aiMsgId
              ? { ...m, content: cleanText, missionRecommend: mission ?? undefined }
              : m
          )
        )
      }

    } catch (error: any) {
      console.error('[Client Chat Error]:', error)
      const displayError = error.message?.includes('AI_API_ERROR') 
        ? '상담량이 많아 일시적으로 응답이 지연되고 있습니다.' 
        : (error.message || '상담 도중 연결이 끊어졌습니다.');
      
      setErrorState(displayError)
      setMessages(prev =>
        prev.map(m =>
          m.id === aiMsgId
            ? { ...m, content: `죄송해요, 잠시 문제가 발생했어요. (${displayError}) 아래 버튼을 눌러 다시 시도해 주세요.`, isError: true }
            : m
        )
      )
    } finally {
      setIsStreaming(false)
      inputRef.current?.focus()
    }
  }, [messages, userContext, isStreaming])

  const handleRetry = () => {
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
    if (lastUserMsg) {
      // 마지막 AI 메시지(에러난 것) 제거 후 다시 시도
      setMessages(prev => prev.filter(m => !m.isError))
      sendMessage(lastUserMsg.content)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendMessage(input)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  const quickReplies = QUICK_REPLIES[userContext.currentPhase] || []

  return (
    <div className="flex flex-col h-full bg-gray-950">

      <LoginPromptModal
        open={showLoginPrompt}
        onClose={() => setShowLoginPrompt(false)}
        reason="chat-backup"
        next="/chat"
      />

      {/* Header (Dynamic) */}
      <div className="flex items-center justify-between px-4 py-4 bg-gray-900/50 border-b border-gray-800 backdrop-blur-md sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => router.push('/dashboard')}
            className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-800 text-gray-400 hover:text-white transition-colors"
          >
            ←
          </button>
          <div>
            <h2 className="text-sm font-black text-white">AI 재이 상담소</h2>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 bg-green-500 rounded-full" />
              <span className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Online</span>
            </div>
          </div>
        </div>
        
        {/* Quick Mission View Toggle */}
        <div className="flex items-center gap-2">
          {activeMissions.length > 0 && (
            <button 
              onClick={() => router.push('/mission?filter=active')}
              className="bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 text-[10px] font-black px-3 py-1.5 rounded-full border border-blue-500/30 transition-all flex items-center gap-1.5"
            >
              🎯 진행중 {activeMissions.length}
            </button>
          )}
          <button 
            onClick={() => router.push('/mission')}
            className="text-xs text-gray-500 font-bold px-2 py-1 hover:text-gray-300 transition-colors"
          >
            전체 미션
          </button>
        </div>
      </div>

      {/* Messages List */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6 scrollbar-hide">
        
        {/* 비로그인 사용자: 메시지가 의미 있게 쌓이기 전에는 작은 인디케이터만 노출.
            본격적인 로그인 권유는 5턴 시점 모달(LoginPromptModal)이 담당. */}
        {!user && messages.length < LOGIN_PROMPT_MESSAGE_THRESHOLD && (
          <div className="mb-4 px-3 py-2 rounded-full bg-gray-800/40 border border-white/5 backdrop-blur-sm flex items-center justify-center gap-2 text-[10px] text-gray-400">
            <span>👋 게스트 모드 — 상담 내역은 이 기기에만 저장돼요.</span>
          </div>
        )}

        {/* 전문가 상담 연결 배너 */}
        <div className="mb-4 p-4 rounded-2xl bg-gradient-to-r from-gray-800 to-gray-900 border border-gray-700 flex items-center justify-between gap-4 group hover:border-gray-600 transition-colors cursor-pointer" onClick={() => alert('실제 전문가 1:1 상담 예약 페이지로 연결됩니다. (준비중)')}>
          <div className="flex-1">
            <h4 className="text-[11px] font-black text-white mb-1 flex items-center gap-1">
              <span className="text-purple-400">✨</span> 더 깊은 분석이 필요하신가요?
            </h4>
            <p className="text-[10px] text-gray-400 leading-tight">상위 1% 재회 컨설턴트와의 1:1 심층 상담</p>
          </div>
          <button className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-[10px] font-black rounded-lg transition-colors whitespace-nowrap text-white">
            예약하기
          </button>
        </div>

        {messages.map((msg) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="w-8 h-8 rounded-full bg-purple-700 flex items-center justify-center text-sm mr-2 flex-shrink-0 mt-1">🧠</div>
            )}
            <div className="max-w-[80%] space-y-2">
              <div
                className={`rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white rounded-tr-sm shadow-md shadow-blue-900/20'
                    : 'bg-gray-800 text-gray-100 rounded-tl-sm border border-gray-700/50'
                } ${msg.isError ? 'border-red-500/50 bg-red-950/20' : ''}`}
              >
                {msg.content ? formatContent(msg.content) : (isStreaming && msg.role === 'assistant' ? (
                  <span className="inline-flex gap-1 items-center py-1">
                    <span className="w-1.5 h-1.5 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-blue-300 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </span>
                ) : '')}
                
                {msg.isError && (
                  <button 
                    onClick={handleRetry}
                    className="mt-3 w-full py-2 rounded-lg bg-red-600/20 border border-red-500/50 text-red-200 text-xs font-bold hover:bg-red-600/30 transition-colors"
                  >
                    🔄 다시 시도하기
                  </button>
                )}
              </div>

              {/* 미션 추천 카드 */}
              {msg.missionRecommend && (
                <div className="bg-gradient-to-br from-indigo-950/80 to-purple-950/80 border border-indigo-500/30 rounded-2xl px-5 py-4 shadow-xl animate-fade-in-up">
                  <div className="flex items-center gap-2 text-indigo-400 font-bold mb-2 text-xs uppercase tracking-wider">
                    <span className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center">⭐</span>
                    AI 전담 미션 추천
                  </div>
                  <div className="text-white font-bold text-base mb-1">{msg.missionRecommend.title}</div>
                  <div className="text-indigo-200/70 text-xs leading-relaxed mb-4">{msg.missionRecommend.reason}</div>
                  <button
                    onClick={() => {
                      const title = msg.missionRecommend!.title
                      const mId = dynamicMissionId(title)
                      startMission(mId, title)
                      alert(`'${title}' 미션을 시작했습니다!`)
                    }}
                    disabled={isMissionActiveByTitle(msg.missionRecommend.title) || isMissionCompletedByTitle(msg.missionRecommend.title)}
                    className={clsx(
                      "w-full text-xs font-bold py-2.5 rounded-xl transition-all shadow-lg active:scale-[0.98]",
                      isMissionActiveByTitle(msg.missionRecommend.title) || isMissionCompletedByTitle(msg.missionRecommend.title)
                        ? "bg-gray-700 text-gray-400 cursor-not-allowed"
                        : "bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-900/40"
                    )}
                  >
                    {isMissionActiveByTitle(msg.missionRecommend.title) ? '진행 중인 미션' : isMissionCompletedByTitle(msg.missionRecommend.title) ? '이미 완료한 미션' : '미션 시작하기 →'}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* 빠른 답변 */}
      {messages.length <= 2 && !isStreaming && (
        <div className="px-4 pb-2 flex gap-2 flex-wrap">
          {quickReplies.map(reply => (
            <button
              key={reply}
              onClick={() => sendMessage(reply)}
              className="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-2 rounded-full border border-gray-700 transition-colors"
            >
              {reply}
            </button>
          ))}
        </div>
      )}

      {/* 입력창 */}
      <form onSubmit={handleSubmit} className="px-4 py-3 border-t border-gray-800 bg-gray-900 pb-[calc(env(safe-area-inset-bottom)+12px)]">
        {selectedImage && (
          <div className="mb-3 flex items-center gap-3 bg-gray-800/50 p-2 rounded-xl border border-blue-500/30 animate-fade-in">
            <div className="relative w-12 h-12 rounded-lg overflow-hidden border border-white/10">
              <img src={selectedImage.preview} alt="upload preview" className="w-full h-full object-cover" />
              <button 
                type="button"
                onClick={() => setSelectedImage(null)}
                className="absolute top-0 right-0 bg-black/60 text-white w-4 h-4 flex items-center justify-center text-[10px]"
              >✕</button>
            </div>
            <div className="text-[10px] text-blue-300 font-medium">이미지가 첨부되었습니다.</div>
          </div>
        )}
        
        <div className="flex items-end gap-2">
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleImageSelect} 
            accept="image/*" 
            className="hidden" 
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-10 h-10 bg-gray-800 hover:bg-gray-700 rounded-xl flex items-center justify-center transition-colors flex-shrink-0 border border-gray-700"
          >
            <span className="text-xl">🖼️</span>
          </button>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="고민이나 카톡 캡처를 보내보세요..."
            rows={1}
            className="flex-1 bg-gray-800 text-white placeholder-gray-500 rounded-xl px-4 py-3 text-sm resize-none outline-none border border-gray-700 focus:border-purple-500 transition-colors max-h-32"
            style={{ overflowY: 'auto' }}
            disabled={isStreaming}
          />
          <button
            type="submit"
            disabled={(!input.trim() && !selectedImage) || isStreaming}
            className="w-10 h-10 bg-purple-600 hover:bg-purple-500 disabled:bg-gray-700 rounded-xl flex items-center justify-center transition-colors flex-shrink-0 shadow-lg shadow-purple-900/20"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
              <path d="M2 21L23 12 2 3v7l15 2-15 2v7z"/>
            </svg>
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1.5 text-center">이미지 분석을 위해 카톡 캡처를 보낼 수 있습니다.</p>
      </form>
    </div>
  )
}

function getWelcomeMessage(ctx: UserContext): string {
  const typeNames: Record<string, string> = {
    A: '감정소진형',
    B: '갈등반복형',
    C: '대체자형',
    D: '장기이별형',
  }

  const typeName = ctx.breakupType ? typeNames[ctx.breakupType] : '진단'
  
  const phaseMessages: Record<number, string> = {
    1: `안녕하세요 💙 이별 후 힘든 시간을 보내고 계시는군요.\n\n진단 결과를 보니 지금은 **공백기(PHASE 1)**에 계세요. **${typeName}** 케이스의 경우, 이 시기에는 프레임 회복과 감정 안정이 가장 우선입니다.\n\n오늘 가장 마음에 걸리는 것이 무엇인지 편하게 이야기해 주세요. 함께 하나씩 풀어나가겠습니다.`,
    2: `다시 뵙네요 🌱 공백기를 잘 견디고 **자기계발기(PHASE 2)**까지 오셨네요.\n\n이제 변화를 통해 가치를 증명할 시간입니다. 지금 어떤 부분에서 성장을 만들고 싶으신가요? 구체적인 계획을 함께 세워보겠습니다.`,
    3: `드디어 **재접근기(PHASE 3)** 💫 여기까지 오신 것만으로도 정말 대단한 일을 하신 거예요.\n\n이제 전략적인 재접촉이 필요합니다. 상대방의 반응을 예측하고 최선의 타이밍을 잡아야 해요. 현재 준비 상황을 말씀해 주세요.`,
  }
  
  return phaseMessages[ctx.currentPhase] || phaseMessages[1]
}
