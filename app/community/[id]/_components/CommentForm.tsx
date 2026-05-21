'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createComment } from '../../actions'
import LoginPromptModal from '@/components/auth/LoginPromptModal'

export default function CommentForm({
  postId,
  isLoggedIn,
}: {
  postId: string
  isLoggedIn: boolean
}) {
  const router = useRouter()
  const [content, setContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [isPending, startTransition] = useTransition()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isLoggedIn) {
      setShowPrompt(true)
      return
    }
    if (content.trim().length === 0) return
    setError(null)

    startTransition(async () => {
      const res = await createComment({ postId, content: content.trim() })
      if (!res.ok) {
        setError(res.error ?? '댓글 작성에 실패했습니다.')
        return
      }
      setContent('')
      router.refresh()
    })
  }

  return (
    <>
      <LoginPromptModal
        open={showPrompt}
        onClose={() => setShowPrompt(false)}
        reason="community-write"
        next={`/community/${postId}`}
      />
      <form onSubmit={handleSubmit} className="space-y-2">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={1000}
          rows={3}
          placeholder={isLoggedIn ? '응원이나 조언을 남겨주세요...' : '로그인 후 댓글 작성 가능'}
          className="w-full bg-gray-800 text-white text-sm rounded-xl px-4 py-3 border border-gray-700 focus:border-blue-500 outline-none transition-colors resize-none"
        />
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-600">{content.length} / 1000</span>
          <button
            type="submit"
            disabled={isPending || content.trim().length === 0}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 text-white text-xs font-black rounded-full transition-all active:scale-95"
          >
            {isPending ? '게시 중...' : '댓글 달기'}
          </button>
        </div>
        {error && (
          <div className="p-2 rounded-lg bg-red-950/40 border border-red-500/30 text-red-300 text-xs">
            {error}
          </div>
        )}
      </form>
    </>
  )
}
