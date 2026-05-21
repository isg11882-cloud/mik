'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'

export default function DiagnosisResultPage() {
  const router = useRouter()
  const { diagnosis: result, user } = useAppStore()

  // 진단 결과가 없으면 랜딩으로 튕김
  useEffect(() => {
    if (!result) {
      router.replace('/')
    }
  }, [result, router])

  if (!result) return null

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col max-w-md mx-auto pb-10">
      
      {/* Header */}
      <div className="flex items-center px-4 py-4 border-b border-gray-800 bg-gray-900/50 sticky top-0 z-10">
        <h2 className="font-bold text-lg text-white mx-auto">진단 결과 보고서</h2>
      </div>

      <div className="p-5 space-y-6 animate-fade-in-up">
        
        {/* 요약 카드 */}
        <div className="glass p-6 rounded-2xl border border-gray-800 text-center relative overflow-hidden">
          <div className="absolute top-0 right-0 p-4 opacity-10 text-6xl">📊</div>
          
          <div className="text-sm text-blue-400 font-bold mb-2">분석 완료</div>
          <h3 className="text-white text-lg">당신의 이별 유형은</h3>
          <div className="text-4xl font-extrabold mt-3 mb-1 gradient-text drop-shadow-[0_0_15px_rgba(155,89,182,0.5)]">
            TYPE {result.breakupType}
          </div>
          <div className="text-xl font-bold text-white mb-4">"{result.title}"</div>
          
          <div className="bg-gray-900/50 rounded-xl p-4 mt-4">
            <p className="text-sm text-gray-300 leading-relaxed">
              {result.summary}
            </p>
          </div>
        </div>

        {/* 현재 PHASE 및 가능성 */}
        <div className="grid grid-cols-2 gap-4">
          <div className="glass p-5 rounded-2xl border border-gray-800">
            <div className="text-xs text-gray-400 mb-1">현재 상태</div>
            <div className="text-xl font-bold text-blue-400">PHASE {result.phase}</div>
            <div className="text-xs text-gray-500 mt-1">
              {result.phase === 1 ? '공백기 (감정 안정)' : result.phase === 2 ? '자기계발기 (변화)' : '재접근기 (실행)'}
            </div>
          </div>
          <div className="glass p-5 rounded-2xl border border-gray-800">
            <div className="text-xs text-gray-400 mb-1">재회 가능성 검토</div>
            <div className="text-lg font-bold text-green-400">{result.successRate}</div>
            <div className="text-xs text-gray-500 mt-1">체계적 접근 시 상승</div>
          </div>
        </div>

        {/* 행동 강령 */}
        <div className="glass p-6 rounded-2xl border border-red-900/30 bg-gradient-to-b from-gray-900 to-red-950/20">
          <h4 className="text-red-400 font-bold mb-3 flex items-center gap-2">
            ⚠️ 절대 금지 행동
          </h4>
          <ul className="text-sm text-gray-300 space-y-2 list-disc pl-4 marker:text-red-500">
            <li>감정에 호소하는 장문의 카톡 보내기</li>
            <li>집 앞이나 직장에 예고 없이 찾아가기</li>
            <li>술 먹고 밤늦게 전화하기</li>
            <li>SNS에 힘든 티 내거나 저격글 올리기</li>
          </ul>
        </div>

      </div>

      {/* Login Nudge Card (Only for non-logged-in users) */}
      {!user && (
        <div className="px-6 mb-12">
          <div className="bg-gradient-to-br from-blue-600/20 to-purple-600/20 border border-blue-500/30 p-8 rounded-[2.5rem] text-center shadow-2xl shadow-blue-500/10 backdrop-blur-xl">
            <div className="w-16 h-16 bg-white/10 rounded-2xl mx-auto flex items-center justify-center text-3xl mb-6 animate-bounce">
              💾
            </div>
            <h3 className="text-xl font-black mb-3">리포트 평생 보관하기</h3>
            <p className="text-gray-400 text-sm mb-8 leading-relaxed">
              지금 보신 전문 진단 결과와 분석 리포트를<br/>
              언제 어디서든 꺼내 볼 수 있게 안전하게 저장하세요.
            </p>
            <button
              onClick={() => router.push('/login?reason=save-report&next=/dashboard')}
              className="w-full py-5 bg-gradient-to-r from-blue-600 to-purple-600 rounded-2xl font-black text-sm shadow-xl shadow-blue-600/20 active:scale-95 transition-all"
            >
              3초만에 저장하고 동기화하기
            </button>
            <p className="mt-4 text-[10px] text-gray-500 font-medium">카카오/구글로 간편하게 시작하세요</p>
          </div>
        </div>
      )}

      {/* CTA 버튼 영역 */}
      <div className="px-5 mt-auto space-y-3">
        <button 
          onClick={() => {
            // URL params로 컨텍스트 넘김
            const params = new URLSearchParams({
              type: result.breakupType,
              days: String(result.daysSinceBreakup),
              phase: String(result.phase)
            })
            router.push(`/chat?${params.toString()}`)
          }}
          className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold py-4 rounded-xl shadow-lg transition-transform hover:scale-[1.02]"
        >
          <span className="text-xl">🤖</span> AI 상담사 '재이'와 상담 시작
        </button>

        {/* 추가된 실제 상담 연계 버튼 */}
        <button 
          onClick={() => alert("현재 전문가 상담 예약 시스템은 준비 중입니다. AI 상담을 먼저 이용해 주세요.")}
          className="w-full flex items-center justify-center gap-2 bg-gray-800 border border-gray-700 hover:bg-gray-700 text-white font-bold py-4 rounded-xl transition-colors"
        >
          <span className="text-xl">🧑‍💼</span> 1:1 프리미엄 전화 상담 예약
        </button>
      </div>

    </div>
  )
}
