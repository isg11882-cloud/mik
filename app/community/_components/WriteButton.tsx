'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import LoginPromptModal from '@/components/auth/LoginPromptModal'

export default function WriteButton({ isLoggedIn }: { isLoggedIn: boolean }) {
  const router = useRouter()
  const [showLoginPrompt, setShowLoginPrompt] = useState(false)

  const handleClick = () => {
    if (!isLoggedIn) {
      setShowLoginPrompt(true)
      return
    }
    router.push('/community/new')
  }

  return (
    <>
      <LoginPromptModal
        open={showLoginPrompt}
        onClose={() => setShowLoginPrompt(false)}
        reason="community-write"
        next="/community/new"
      />
      <button
        onClick={handleClick}
        className="px-4 py-2 bg-white hover:bg-gray-200 transition-colors text-black text-[10px] font-black rounded-full"
      >
        글쓰기
      </button>
    </>
  )
}
