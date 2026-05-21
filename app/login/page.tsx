'use client'

import { createSupabaseBrowser, isSupabaseConfigured } from '@/lib/supabase/client'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'

const VALUE_CARDS = [
  { icon: '📊', title: '진단 리포트', desc: '내 이별 유형과 PHASE를 언제든 다시 확인' },
  { icon: '💬', title: 'AI 상담 내역', desc: '재이와 나눈 대화가 기기 변경에도 사라지지 않음' },
  { icon: '🎯', title: '미션 진행도', desc: '쌓아 올린 포인트와 완료 미션 영구 보관' },
  { icon: '📈', title: '감정 회복 그래프', desc: '주차별 회복 흐름을 잃어버리지 않도록' },
]

function LoginPageContent() {
  const router = useRouter()
  const params = useSearchParams()
  const supabase = createSupabaseBrowser()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const [isSent, setIsSent] = useState(false)

  // 로그인 완료 후 돌아갈 경로 (없으면 /dashboard)
  const next = params.get('next') || '/dashboard'
  const reason = params.get('reason') // 'save-report' | 'chat-backup' | 'community-write' 등
  const oauthError = params.get('error') // 'auth_failed' 등 — auth/callback 에서 redirect

  // 환경변수 누락 — 운영에 NEXT_PUBLIC_SUPABASE_URL 안 박혔을 때
  const supabaseReady = isSupabaseConfigured()

  const handleLogin = async (provider: 'google' | 'kakao' | 'email') => {
    if (!supabaseReady) {
      alert(
        '서비스 설정에 문제가 있어 로그인할 수 없습니다.\n관리자에게 알려주세요.\n(Supabase 환경변수 누락)',
      )
      return
    }
    setLoading(provider)

    if (provider === 'email') {
      if (!email) {
        alert('이메일 주소를 입력해주세요.')
        setLoading(null)
        return
      }
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      })
      if (error) {
        console.error('[Login Error]', error)
        alert('로그인 오류가 발생했습니다.\n' + error.message)
      } else {
        setIsSent(true)
      }
      setLoading(null)
      return
    }

    // Google / Kakao 공통 OAuth
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        queryParams:
          provider === 'kakao'
            ? { scope: 'profile_nickname,profile_image' }
            : undefined,
      },
    })

    if (error) {
      alert(`로그인 오류: ${error.message}`)
      setLoading(null)
    }
  }

  // 메일 전송 성공 화면
  if (isSent) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-full max-w-sm space-y-12">
          <div className="w-24 h-24 bg-blue-600/20 rounded-[2.5rem] mx-auto flex items-center justify-center text-5xl animate-bounce">
            📧
          </div>
          <div className="space-y-4">
            <h1 className="text-3xl font-black text-white">메일을 확인해주세요!</h1>
            <p className="text-gray-400 text-sm leading-relaxed">
              <span className="text-blue-400 font-bold underline">{email}</span> 주소로
              <br />
              로그인 링크를 보냈습니다.
            </p>
          </div>

          <div className="space-y-3">
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-[0.2em] mb-4">
              Quick Open
            </p>
            <div className="grid grid-cols-2 gap-3">
              <a
                href="https://mail.google.com"
                target="_blank"
                rel="noreferrer"
                className="py-5 bg-gray-900 border border-white/5 rounded-2xl text-xs font-black hover:bg-gray-800 transition-all shadow-xl"
              >
                지메일 바로가기
              </a>
              <a
                href="https://mail.naver.com"
                target="_blank"
                rel="noreferrer"
                className="py-5 bg-gray-900 border border-white/5 rounded-2xl text-xs font-black hover:bg-gray-800 transition-all shadow-xl"
              >
                네이버 메일 바로가기
              </a>
            </div>
            <a
              href="https://mail.kakao.com"
              target="_blank"
              rel="noreferrer"
              className="w-full block py-5 bg-gray-900 border border-white/5 rounded-2xl text-xs font-black hover:bg-gray-800 transition-all shadow-xl mt-3"
            >
              카카오 메일 바로가기
            </a>
          </div>

          <button
            onClick={() => setIsSent(false)}
            className="text-gray-500 text-xs hover:text-white transition-colors underline pt-4"
          >
            다른 이메일 주소 사용하기
          </button>
        </div>
      </div>
    )
  }

  // 로그인 사유 헤드라인 (트리거별 컨텍스트 메시지)
  const reasonHeadline: Record<string, { title: string; sub: string }> = {
    'save-report': {
      title: '진단 리포트를 안전하게 보관할까요?',
      sub: '로그인하면 지금의 분석 결과가 평생 사라지지 않아요.',
    },
    'chat-backup': {
      title: '지금까지의 상담을 잃지 않으려면',
      sub: '계정에 연결하면 기기를 바꿔도 대화가 그대로 따라옵니다.',
    },
    'community-write': {
      title: '글을 남기려면 로그인이 필요해요',
      sub: '익명 글쓰기는 계정 인증 후에 가능합니다.',
    },
  }
  const headline: { title: string; sub: string } | null = reason ? reasonHeadline[reason] ?? null : null

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-8 text-center">
        <div className="space-y-4">
          <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl mx-auto flex items-center justify-center text-3xl shadow-xl shadow-blue-500/20">
            🤝
          </div>
          <h1 className="text-2xl font-black text-white leading-tight">
            {headline?.title ?? '내 데이터를 안전하게 저장하기'}
          </h1>
          <p className="text-gray-400 text-xs leading-relaxed">
            {headline?.sub ?? '로그인하면 지금까지의 진행을 계정에 연결해 보관합니다.'}
          </p>
        </div>

        {/* OAuth 콜백 실패 시 안내 */}
        {oauthError && (
          <div className="p-4 rounded-2xl bg-red-950/40 border border-red-500/30 text-left">
            <div className="text-[11px] font-black text-red-400 uppercase tracking-widest mb-1">
              로그인 실패
            </div>
            <p className="text-xs text-red-200 leading-relaxed">
              인증 도중 문제가 발생했어요. 잠시 후 다시 시도해 주세요. 같은 문제가 반복되면 시크릿 창이나 다른 브라우저로 시도해 보세요.
            </p>
          </div>
        )}

        {/* Supabase 환경변수 누락 또는 API Key 규격 오류 시 경고 */}
        {!supabaseReady && (
          <div className="p-4 rounded-2xl bg-yellow-950/40 border border-yellow-500/30 text-left">
            <div className="text-[11px] font-black text-yellow-400 uppercase tracking-widest mb-1">
              서비스 설정 오류 감지
            </div>
            <p className="text-xs text-yellow-200 leading-relaxed">
              현재 로그인 서비스 연결(Supabase API 키 설정)에 문제가 있습니다.
              <br />
              <span className="text-yellow-400 font-bold">.env.local</span>의 <span className="text-yellow-400 font-bold">NEXT_PUBLIC_SUPABASE_ANON_KEY</span>가 올바른 public anon key(반드시 eyJhbG...로 시작하는 긴 JWT 포맷)로 설정되어 있는지 점검해 주세요.
            </p>
          </div>
        )}

        {/* 가치 4카드 — 무엇이 저장되는지 명시 */}
        <div className="grid grid-cols-2 gap-3 text-left">
          {VALUE_CARDS.map((card) => (
            <div
              key={card.title}
              className="bg-gray-900/60 border border-white/5 rounded-2xl p-4 backdrop-blur"
            >
              <div className="text-2xl mb-2">{card.icon}</div>
              <div className="text-[11px] font-black text-white mb-1">{card.title}</div>
              <div className="text-[10px] text-gray-400 leading-tight">{card.desc}</div>
            </div>
          ))}
        </div>

        {/* 소셜 로그인 영역 */}
        <div className="space-y-3">
          {/* 카카오 로그인 — 한국 사용자 최우선 */}
          <button
            onClick={() => handleLogin('kakao')}
            disabled={!!loading}
            className="w-full h-[54px] bg-[#FEE500] text-[#191919] font-bold rounded-[12px] flex items-center justify-center gap-3 transition-all active:scale-[0.98] hover:bg-[#FEE500]/95 disabled:opacity-50 shadow-sm"
          >
            <svg
              className="w-5 h-5 text-[#191919]"
              viewBox="0 0 24 24"
              fill="currentColor"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M12 3c-4.97 0-9 3.185-9 7.115 0 2.557 1.707 4.8 4.316 6.09-.27 1.01-1.077 4.02-1.123 4.22-.07.3.11.3.23.22.1-.06 1.6-1.08 4.54-3.07.34.05.69.07 1.037.07 4.97 0 9-3.186 9-7.115C21 6.185 16.97 3 12 3z" />
            </svg>
            <span className="text-[15px] tracking-tight">
              {loading === 'kakao' ? '카카오 로그인 중...' : '카카오로 시작하기'}
            </span>
          </button>

          {/* 구글 로그인 */}
          <button
            onClick={() => handleLogin('google')}
            disabled={!!loading}
            className="w-full h-[54px] bg-[#FFFFFF] text-[#1F1F1F] font-bold rounded-[12px] flex items-center justify-center gap-3 transition-all border border-[#E0E0E0] active:scale-[0.98] hover:bg-[#F8F9FA] disabled:opacity-50 shadow-sm"
          >
            <svg
              className="w-5 h-5"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                fill="#EA4335"
                d="M12 5.04c1.62 0 3.08.56 4.22 1.64l3.15-3.15C17.45 1.71 14.93 1 12 1 7.36 1 3.37 3.69 1.42 7.63l3.86 3C6.2 7.69 8.87 5.04 12 5.04z"
              />
              <path
                fill="#4285F4"
                d="M23.49 12.275c0-.826-.074-1.62-.21-2.387H12v4.513h6.44c-.278 1.458-1.099 2.695-2.33 3.525v2.93h3.774c2.207-2.03 3.48-5.02 3.48-8.58z"
              />
              <path
                fill="#34A853"
                d="M12 23c3.24 0 5.97-1.08 7.96-2.91l-3.77-2.93c-1.12.75-2.55 1.19-4.19 1.19-3.13 0-5.8-2.65-6.72-5.59H1.42v3.02C3.37 20.31 7.36 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.28 12.76c-.24-.72-.38-1.49-.38-2.28s.14-1.56.38-2.28V5.18H1.42C.52 6.99 0 9.03 0 11.2s.52 4.21 1.42 6.02l3.86-3.02c-.24-.72-.38-1.49-.38-2.28z"
              />
            </svg>
            <span className="text-[15px] tracking-tight">
              {loading === 'google' ? '구글 로그인 중...' : 'Google 계정으로 시작하기'}
            </span>
          </button>
        </div>

        {/* 이메일 OTP — Fallback */}
        <div className="relative py-2">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-white/5" />
          </div>
          <div className="relative flex justify-center text-[10px] uppercase">
            <span className="bg-gray-950 px-2 text-gray-500 font-bold tracking-widest">또는</span>
          </div>
        </div>

        <div className="space-y-3 p-5 bg-gray-900/40 rounded-2xl border border-white/5">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest text-left px-1">
            이메일 매직 링크
          </p>
          <input
            type="email"
            placeholder="이메일 주소 입력"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full h-12 bg-gray-800 rounded-xl px-4 text-sm text-white border border-transparent focus:border-blue-500 transition-all outline-none"
          />
          <button
            onClick={() => handleLogin('email')}
            disabled={!!loading}
            className="w-full h-12 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl transition-all active:scale-95 disabled:opacity-50"
          >
            {loading === 'email' ? '전송 중...' : '로그인 링크 받기'}
          </button>
        </div>

        <button
          onClick={() => router.push(next === '/dashboard' ? '/' : next)}
          className="text-gray-500 text-xs hover:text-white transition-colors underline pt-2"
        >
          나중에 할게요
        </button>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gray-950 flex items-center justify-center text-white">
          로그인 준비 중...
        </div>
      }
    >
      <LoginPageContent />
    </Suspense>
  )
}
