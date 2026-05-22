'use client'

import { usePathname } from 'next/navigation'

interface MainContainerProps {
  children: React.ReactNode
}

export default function MainContainer({ children }: MainContainerProps) {
  const pathname = usePathname()
  
  // 하단 탭바(BottomNav)를 노출하지 않는 페이지는 하단 패딩(pb-24)을 전면 제거하여
  // 채팅창 붕 뜸 및 뷰포트 스크롤 왜곡을 방지합니다.
  const hidePaths = ['/', '/diagnosis', '/chat', '/login']
  const shouldHidePadding = hidePaths.some(p => p === pathname || pathname.startsWith(p + '/'))

  return (
    <main className={shouldHidePadding ? "" : "pb-24"}>
      {children}
    </main>
  )
}
