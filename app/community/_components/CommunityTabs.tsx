'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { clsx } from 'clsx'

type Tab = 'story' | 'forum'

export default function CommunityTabs({ active }: { active: Tab }) {
  const router = useRouter()
  const params = useSearchParams()

  const setTab = (tab: Tab) => {
    const next = new URLSearchParams(params)
    next.set('tab', tab)
    router.push(`/community?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="flex gap-4 border-b border-white/5">
      <button
        onClick={() => setTab('story')}
        className={clsx(
          'pb-3 text-sm font-bold transition-all relative',
          active === 'story' ? 'text-blue-400' : 'text-gray-500',
        )}
      >
        성공 후기
        {active === 'story' && (
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
        )}
      </button>
      <button
        onClick={() => setTab('forum')}
        className={clsx(
          'pb-3 text-sm font-bold transition-all relative',
          active === 'forum' ? 'text-blue-400' : 'text-gray-500',
        )}
      >
        익명 고민 광장
        {active === 'forum' && (
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
        )}
      </button>
    </div>
  )
}
