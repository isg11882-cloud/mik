'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { clsx } from 'clsx'

const NAV_ITEMS = [
  { label: '홈', icon: '🏠', href: '/dashboard' },
  { label: '미션', icon: '🎯', href: '/mission' },
  { label: 'AI상담', icon: '💬', href: '/chat' },
  { label: '커뮤니티', icon: '🫂', href: '/community' },
  { label: '마이페이지', icon: '👤', href: '/mypage' },
]

export default function BottomNav() {
  const pathname = usePathname()

  // 랜딩페이지, 진단 중, 채팅창에서는 하단바를 숨김 (채팅 입력창 가림 방지)
  const hidePaths = ['/', '/diagnosis', '/chat']
  if (hidePaths.includes(pathname)) return null

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 flex justify-center pb-6 px-4 pointer-events-none">
      <div className="flex items-center justify-between w-full max-w-md bg-gray-900/80 backdrop-blur-xl border border-white/10 rounded-2xl px-2 py-2 shadow-2xl pointer-events-auto shadow-black/40">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname.startsWith(item.href)
          
          return (
            <Link 
              key={item.href} 
              href={item.href}
              className={clsx(
                "flex flex-col items-center justify-center flex-1 py-2 px-1 rounded-xl transition-all duration-300 gap-1",
                isActive 
                  ? "bg-white/10 text-blue-400" 
                  : "text-gray-500 hover:text-gray-300"
              )}
            >
              <span className={clsx(
                "text-xl transition-transform duration-300",
                isActive && "scale-110"
              )}>
                {item.icon}
              </span>
              <span className={clsx(
                "text-[10px] font-bold tracking-tight",
                isActive ? "text-blue-400" : "text-gray-500"
              )}>
                {item.label}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
