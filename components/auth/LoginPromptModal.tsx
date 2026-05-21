'use client'

import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'

interface LoginPromptModalProps {
  open: boolean
  onClose: () => void
  reason: 'chat-backup' | 'save-report' | 'community-write'
  next?: string
  // 헤드라인/설명 커스터마이징(선택)
  title?: string
  description?: string
}

const DEFAULT_COPY: Record<LoginPromptModalProps['reason'], { title: string; description: string }> = {
  'chat-backup': {
    title: '지금까지의 상담을 잃지 않으려면',
    description: '계정에 연결하면 기기를 바꿔도 대화가 그대로 따라옵니다. 30초면 됩니다.',
  },
  'save-report': {
    title: '진단 리포트를 안전하게 보관할까요?',
    description: '지금 분석한 결과를 평생 다시 볼 수 있도록 계정에 저장할 수 있어요.',
  },
  'community-write': {
    title: '글을 남기려면 로그인이 필요해요',
    description: '익명으로 표시되지만, 계정 인증 후에만 글을 쓸 수 있습니다.',
  },
}

export default function LoginPromptModal({
  open,
  onClose,
  reason,
  next,
  title,
  description,
}: LoginPromptModalProps) {
  const router = useRouter()
  const { markLoginPrompted } = useAppStore()

  if (!open) return null

  const copy = {
    title: title ?? DEFAULT_COPY[reason].title,
    description: description ?? DEFAULT_COPY[reason].description,
  }

  const handleGoLogin = () => {
    markLoginPrompted()
    const params = new URLSearchParams({ reason })
    if (next) params.set('next', next)
    router.push(`/login?${params.toString()}`)
  }

  const handleLater = () => {
    markLoginPrompted()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in"
      onClick={handleLater}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-gray-900 border border-white/10 rounded-3xl p-6 shadow-2xl"
      >
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-2xl mb-5 shadow-lg">
          💾
        </div>
        <h3 className="text-lg font-black text-white mb-2 leading-tight">{copy.title}</h3>
        <p className="text-sm text-gray-400 leading-relaxed mb-6">{copy.description}</p>

        <div className="space-y-2">
          <button
            onClick={handleGoLogin}
            className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white text-sm font-black rounded-xl shadow-lg shadow-blue-900/30 active:scale-[0.98] transition-all"
          >
            안전하게 저장하기 →
          </button>
          <button
            onClick={handleLater}
            className="w-full py-3 text-xs font-bold text-gray-500 hover:text-gray-300 transition-colors"
          >
            나중에 할게요
          </button>
        </div>
      </div>
    </div>
  )
}
