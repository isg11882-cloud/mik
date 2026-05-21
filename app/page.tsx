'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { useAppStore } from '@/lib/store'

export default function LandingPage() {
  const router = useRouter()
  const { diagnosis } = useAppStore()

  useEffect(() => {
    if (diagnosis) {
      router.push('/dashboard')
    }
  }, [diagnosis, router])

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-[url('/bg-stars.svg')] bg-cover bg-center">
      <div className="w-full max-w-md flex flex-col items-center text-center space-y-8 animate-fade-in-up">
        
        {/* 로고 & 서브타이틀 */}
        <div className="space-y-4">
          <div className="w-20 h-20 mx-auto bg-white/5 border border-white/10 rounded-2xl flex items-center justify-center text-4xl shadow-xl glass pulse-glow">
            🧭
          </div>
          <div className="uppercase tracking-widest text-[#5AAFEE] text-xs font-bold font-mono">
            재회심리학 기반 AI 컨설팅
          </div>
          <h1 className="text-3xl font-extrabold text-white leading-tight">
            막연한 기다림이 아닌,<br/>
            <span className="gradient-text">준비된 재회</span>를 시작하세요.
          </h1>
          <p className="text-[#8BACC8] text-sm leading-relaxed max-w-[280px] mx-auto">
            17가지 재회심리학 이론과 분석을 통해<br/>
            당신만의 객관적이고 체계적인 로드맵을 제공합니다.
          </p>
        </div>

        {/* Feature List */}
        <div className="w-full space-y-3 text-left">
          <div className="glass rounded-xl p-4 flex gap-4 items-center">
            <div className="text-2xl">🔍</div>
            <div>
              <strong className="block text-white text-sm">입체적 현황 진단</strong>
              <span className="text-[#8BACC8] text-xs">9문항으로 이별 유형과 가능성을 즉시 분석합니다.</span>
            </div>
          </div>
          
          <div className="glass rounded-xl p-4 flex gap-4 items-center">
            <div className="text-2xl">🤖</div>
            <div>
              <strong className="block text-white text-sm">24시간 AI 컨설턴트 '재이'</strong>
              <span className="text-[#8BACC8] text-xs">감정에 치우치지 않는 냉철하고 따뜻한 조언.</span>
            </div>
          </div>

          <div className="glass rounded-xl p-4 flex gap-4 items-center">
            <div className="text-2xl">🎯</div>
            <div>
              <strong className="block text-white text-sm">전문가 심층 상담 연계</strong>
              <span className="text-[#8BACC8] text-xs">AI 코칭 후, 실제 전문가와의 1:1 상담으로 확실한 마무리를.</span>
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="w-full pt-4">
          <button 
            onClick={() => router.push('/diagnosis')}
            className="w-full py-4 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-lg shadow-[0_0_20px_rgba(79,70,229,0.3)] transition-all hover:scale-[1.02] active:scale-95"
          >
            내 재회 가능성 무료 진단하기 →
          </button>
          <div className="mt-4 text-xs text-slate-500/80">
            * 진단 결과는 기기 내에만 안전하게 저장됩니다.
          </div>
        </div>

      </div>
    </div>
  )
}
