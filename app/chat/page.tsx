'use client'

/**
 * /chat — AI 상담 페이지
 * 사용자 컨텍스트를 zustand store 또는 URL params 에서 읽어 ChatWindow에 전달
 */

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import ChatWindow from '@/components/chat/ChatWindow'
import { useAppStore } from '@/lib/store'
import type { UserContext } from '@/lib/ai-system-prompt'

function ChatPageContent() {
  const params = useSearchParams()
  const { diagnosis } = useAppStore()

  // 1. URL 파라미터 우선 (수동 테스트용)
  // 2. 파라미터 없으면 스토어의 진단 데이터 사용
  const userContext: UserContext = {
    breakupType: (params.get('type') as 'A'|'B'|'C'|'D') || (diagnosis?.breakupType as any) || null,
    daysSinceBreakup: Number(params.get('days')) || diagnosis?.daysSinceBreakup || 0,
    currentPhase: (Number(params.get('phase')) as 1|2|3) || diagnosis?.phase || 1,
    situation: params.get('situation') || diagnosis?.summary || undefined,
  }

  return (
    <div className="flex flex-col bg-gray-950 overflow-hidden" style={{ height: 'var(--vv-height, 100dvh)' }}>
      <ChatWindow userContext={userContext} />
    </div>
  )
}

export default function ChatPage() {
  return (
    <Suspense fallback={
      <div className="h-[100dvh] flex items-center justify-center bg-gray-950 text-white">
        상담 준비 중...
      </div>
    }>
      <ChatPageContent />
    </Suspense>
  )
}
