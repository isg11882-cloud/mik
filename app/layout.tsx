import type { Metadata } from 'next'
import './globals.css'

const SITE_URL =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ||
  'https://ex-back-three.vercel.app'
const SITE_TITLE = '재회 컨설팅 | 재회심리학 기반 AI 컨설팅'
const SITE_DESC =
  '막연한 기다림이 아닌, 준비된 재회를 시작하세요. 9문항 진단부터 24시간 AI 상담, 단계별 미션까지.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESC,
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESC,
    type: 'website',
    url: SITE_URL,
    siteName: '재회 컨설팅',
    locale: 'ko_KR',
    // images 는 app/opengraph-image.tsx 로 자동 주입됨
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESC,
    // images 도 opengraph-image.tsx 와 공유
  },
  // 검색엔진 / 카카오톡 미리보기 친화
  robots: {
    index: true,
    follow: true,
  },
}

import BottomNav from '@/components/layout/BottomNav'
import AuthObserver from '@/components/auth/AuthObserver'
import MainContainer from '@/components/layout/MainContainer'

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className={`bg-gray-950 text-white min-h-screen`}>
        <AuthObserver />
        <MainContainer>
          {children}
        </MainContainer>
        <BottomNav />
      </body>
    </html>
  );
}

