'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toggleLike } from '../../actions'
import LoginPromptModal from '@/components/auth/LoginPromptModal'
import { clsx } from 'clsx'

interface Props {
  postId: string
  initialLiked: boolean
  initialCount: number
  isLoggedIn: boolean
}

export default function LikeButton({ postId, initialLiked, initialCount, isLoggedIn }: Props) {
  const router = useRouter()
  const [liked, setLiked] = useState(initialLiked)
  const [count, setCount] = useState(initialCount)
  const [showPrompt, setShowPrompt] = useState(false)
  const [, startTransition] = useTransition()

  const handleClick = () => {
    if (!isLoggedIn) {
      setShowPrompt(true)
      return
    }

    // Optimistic UI
    const nextLiked = !liked
    const nextCount = count + (nextLiked ? 1 : -1)
    setLiked(nextLiked)
    setCount(nextCount)

    startTransition(async () => {
      const res = await toggleLike(postId)
      if (!res.ok) {
        // 롤백
        setLiked(!nextLiked)
        setCount(count)
        alert(res.error)
        return
      }
      // 서버 응답이 다르면 동기화
      if (res.liked !== nextLiked) {
        setLiked(res.liked)
        setCount(initialCount + (res.liked ? 1 : 0))
      }
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
      <button
        onClick={handleClick}
        className={clsx(
          'flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-black border transition-all active:scale-95',
          liked
            ? 'bg-pink-500/20 border-pink-500/50 text-pink-300'
            : 'bg-gray-900 border-gray-800 text-gray-400 hover:border-pink-500/30',
        )}
      >
        <span>{liked ? '❤️' : '🤍'}</span>
        <span>{count}</span>
      </button>
    </>
  )
}
