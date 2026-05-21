/**
 * Open Graph 이미지 — 카카오톡 / Slack / Twitter / Discord 등에 링크 공유 시 노출.
 *
 * Next.js 15 App Router 의 자동 인식 파일:
 *   - 이 파일이 있으면 metadata.openGraph.images / twitter.images 자동 설정.
 *   - 빌드 시 1번 생성되어 Edge 에서 캐시 (재요청마다 다시 그리지 않음).
 *
 * 한글 렌더링: Pretendard Bold woff 를 빌드 시 fetch 하여 satori 에 전달.
 * fetch 실패 시 fallback 폰트 사용 (한글이 깨질 수 있으니 영문 카피와 병행).
 */

import { ImageResponse } from 'next/og'

export const alt = '재회컨설팅 — 재회심리학 기반 AI 컨설팅'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function OpengraphImage() {
  // 한글 폰트 — Pretendard Bold (woff). satori 호환.
  let pretendardBold: ArrayBuffer | null = null
  try {
    const res = await fetch(
      'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/packages/pretendard/dist/web/static/woff/Pretendard-Bold.woff',
    )
    if (res.ok) {
      pretendardBold = await res.arrayBuffer()
    }
  } catch {
    // fetch 실패 — fallback 폰트 사용 (영문은 보임)
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0D1B2E',
          backgroundImage:
            'radial-gradient(ellipse at top, rgba(46, 117, 182, 0.18) 0%, transparent 60%), linear-gradient(135deg, #0D1B2E 0%, #162436 50%, #0D1B2E 100%)',
          color: '#FFFFFF',
          padding: '80px',
          fontFamily: 'Pretendard',
        }}
      >
        {/* 컴파스 로고 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 120,
            height: 120,
            borderRadius: 28,
            backgroundColor: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(90, 175, 238, 0.3)',
            fontSize: 72,
            marginBottom: 36,
            boxShadow: '0 0 60px rgba(46, 117, 182, 0.4)',
          }}
        >
          🧭
        </div>

        {/* 카테고리 */}
        <div
          style={{
            fontSize: 28,
            color: '#5AAFEE',
            letterSpacing: '0.25em',
            marginBottom: 32,
            fontWeight: 700,
            textTransform: 'uppercase',
            display: 'flex',
          }}
        >
          재회심리학 기반 AI 컨설팅
        </div>

        {/* 메인 카피 */}
        <div
          style={{
            fontSize: 72,
            fontWeight: 800,
            textAlign: 'center',
            lineHeight: 1.2,
            marginBottom: 32,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
        >
          <span style={{ color: '#E8EDF4' }}>막연한 기다림이 아닌,</span>
          <span
            style={{
              backgroundImage: 'linear-gradient(135deg, #5AAFEE, #9B59B6)',
              backgroundClip: 'text',
              color: 'transparent',
              marginTop: 8,
            }}
          >
            준비된 재회를 시작하세요.
          </span>
        </div>

        {/* 서브카피 — 핵심 기능 3 */}
        <div
          style={{
            display: 'flex',
            gap: 24,
            marginTop: 24,
            color: '#8BACC8',
            fontSize: 22,
            fontWeight: 600,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>🔍</span>
            <span>9문항 진단</span>
          </div>
          <div style={{ color: '#3A4A5E' }}>·</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>🤖</span>
            <span>24시간 AI 상담</span>
          </div>
          <div style={{ color: '#3A4A5E' }}>·</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>🎯</span>
            <span>단계별 미션</span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: pretendardBold
        ? [
            {
              name: 'Pretendard',
              data: pretendardBold,
              weight: 700,
              style: 'normal',
            },
          ]
        : undefined,
    },
  )
}
