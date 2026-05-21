'use client'

import { useAppStore } from '@/lib/store'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { getDailyDirective } from '@/lib/data/daily-directives'

export default function DashboardPage() {
  const { diagnosis, activeMissions, user, nickname, breakupDate } = useAppStore()
  const router = useRouter()
  const [mounted, setMounted] = useState(false)

  // 하이드레이션 에러 방지
  useEffect(() => {
    setMounted(true)
    if (!diagnosis) {
      router.push('/')
    }
  }, [diagnosis, router])

  if (!mounted || !diagnosis) return null

  const displayName = nickname || (user?.email?.split('@')[0]) || '재회 꿈나무'

  // 정확한 이별 날짜가 있으면 그것으로, 없으면 진단의 daysSinceBreakup 사용
  const daysSince = breakupDate
    ? Math.max(0, Math.floor((Date.now() - new Date(breakupDate).getTime()) / (1000 * 60 * 60 * 24)))
    : diagnosis.daysSinceBreakup

  const directive = getDailyDirective(diagnosis.breakupType, diagnosis.phase, daysSince)

  // No-Contact 진행 바: PHASE 1(공백기 30일)을 기준으로 채워짐
  const noContactGoalDays = 30
  const noContactProgress = Math.min(100, Math.round((daysSince / noContactGoalDays) * 100))

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col max-w-md mx-auto pb-24 overflow-x-hidden text-white">
      
      {/* 1. Top Header & Welcome */}
      <section className="px-6 pt-10 pb-6 flex justify-between items-end">
        <div className="space-y-1">
          <p className="text-blue-400 text-xs font-bold tracking-widest uppercase">Welcome Back</p>
          <h1 className="text-2xl font-black italic">Hello, {displayName}!</h1>
        </div>
        <Link
          href="/diagnosis/result"
          className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 hover:border-blue-500/40 text-[10px] font-bold text-blue-300 transition-colors"
          title="내 진단 리포트 다시 보기"
        >
          📊 리포트
        </Link>
      </section>

      <div className="px-6 space-y-6">
        
        {/* 2. No-Contact Strategy Card (The Hero Widget) */}
        <div className="relative group">
          <div className="absolute -inset-0.5 bg-gradient-to-r from-blue-500 to-purple-600 rounded-[2.5rem] blur opacity-20 group-hover:opacity-40 transition duration-1000"></div>
          <div className="relative bg-gray-900 rounded-[2.5rem] p-8 border border-white/5 overflow-hidden">
            {/* Background Pattern */}
            <div className="absolute top-0 right-0 p-8 opacity-[0.03] text-9xl -mr-8 -mt-8 rotate-12">⏳</div>
            
            <div className="flex justify-between items-start mb-6">
              <div>
                <span className="px-3 py-1 bg-blue-500/10 text-blue-400 text-[10px] font-black rounded-full border border-blue-500/20 uppercase tracking-tighter">
                  Strategy: No Contact
                </span>
                <h2 className="text-3xl font-black mt-3">D+{daysSince}</h2>
                {!breakupDate && (
                  <div className="text-[10px] text-gray-500 mt-1">
                    * 자동 추정값 ·{' '}
                    <button
                      onClick={() => router.push('/diagnosis')}
                      className="underline hover:text-blue-400"
                    >
                      정확한 날짜 입력
                    </button>
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="text-[10px] text-gray-500 font-bold uppercase mb-1">Success Rate</div>
                <div className="text-xl font-black text-green-400">{diagnosis.successRate}</div>
              </div>
            </div>

            <div className="space-y-4">
              <div className="w-full bg-gray-800 h-2 rounded-full overflow-hidden">
                <div
                  className="bg-gradient-to-r from-blue-500 to-purple-500 h-full shadow-[0_0_10px_rgba(59,130,246,0.5)] transition-all duration-700"
                  style={{ width: `${noContactProgress}%` }}
                />
              </div>
              <p className="text-xs text-gray-400 leading-relaxed font-medium">
                지금은 상대방의 <span className="text-white font-bold">부정적 감정이 희석</span>되는 골든타임입니다.
                침묵은 가장 강력한 무기임을 잊지 마세요.
              </p>
            </div>
          </div>
        </div>

        {/* 3. Daily Directive (Action Card) — 진단 결과/PHASE/경과일에 따라 동적 */}
        <div className="bg-gradient-to-br from-gray-900 to-gray-950 rounded-[2rem] p-6 border border-white/5 shadow-2xl">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-8 h-8 bg-purple-500/20 rounded-xl flex items-center justify-center text-sm">🎯</div>
            <h3 className="font-black text-sm tracking-tight text-white/90">오늘의 행동 지침</h3>
          </div>

          <div className="bg-white/5 rounded-2xl p-4 border border-white/5 mb-4">
            <p className="text-sm text-gray-200 leading-relaxed italic">"{directive.text}"</p>
          </div>

          <Link 
            href="/chat"
            className="w-full py-4 bg-white text-black rounded-2xl font-black text-sm flex items-center justify-center gap-2 hover:bg-gray-200 transition-all active:scale-95"
          >
            대응 지침 상세 상담하기 💬
          </Link>
        </div>

        {/* 4. Mini Stats & Quick Access */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gray-900/50 rounded-3xl p-5 border border-white/5 flex flex-col justify-between aspect-square">
            <div className="w-10 h-10 bg-blue-500/10 rounded-2xl flex items-center justify-center text-xl">💎</div>
            <div>
              <div className="text-[10px] text-gray-500 font-black uppercase mb-1">My Phase</div>
              <div className="text-xl font-black text-white">PHASE {diagnosis.phase}</div>
            </div>
          </div>
          <div className="bg-gray-900/50 rounded-3xl p-5 border border-white/5 flex flex-col justify-between aspect-square">
            <div className="w-10 h-10 bg-orange-500/10 rounded-2xl flex items-center justify-center text-xl">🔥</div>
            <div>
              <div className="text-[10px] text-gray-500 font-black uppercase mb-1">Missions</div>
              <div className="text-xl font-black text-white">{activeMissions.length} Active</div>
            </div>
          </div>
        </div>

        {/* 5. 전문가 상담 배너 */}
        <div 
          onClick={() => alert('실제 전문가 1:1 상담 예약 페이지로 연결됩니다. (준비중)')}
          className="bg-gradient-to-r from-blue-900 to-indigo-900 rounded-[2rem] p-6 border border-blue-500/30 shadow-2xl flex flex-col justify-center items-start cursor-pointer hover:border-blue-400 transition-all active:scale-[0.98] group relative overflow-hidden"
        >
          <div className="absolute right-0 top-0 w-32 h-32 bg-blue-500/20 rounded-full blur-2xl -mr-10 -mt-10 group-hover:bg-blue-400/30 transition-all"></div>
          <span className="px-3 py-1 bg-white/10 text-white text-[10px] font-black rounded-full border border-white/20 uppercase tracking-tighter mb-3 relative z-10">
            Premium Care
          </span>
          <h3 className="text-lg font-black text-white mb-1 relative z-10">상위 1% 전문가 1:1 심층 상담</h3>
          <p className="text-blue-200 text-xs font-medium leading-relaxed mb-4 relative z-10 max-w-[80%]">
            AI 진단을 바탕으로 나만의 맞춤형 재회 마스터 플랜을 세워보세요.
          </p>
          <div className="text-white text-xs font-black flex items-center gap-2 relative z-10">
            예약하기 <span className="group-hover:translate-x-1 transition-transform">→</span>
          </div>
        </div>

        {/* 6. Recent Activity / Motivation */}
        <div className="pb-6">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-black text-sm text-white/80">진행 중인 미션</h3>
            <Link href="/mission" className="text-[10px] text-blue-400 font-bold uppercase tracking-widest">View All</Link>
          </div>
          
          {activeMissions.length > 0 ? (
            <div className="space-y-3">
              {activeMissions.slice(0, 1).map(m => (
                <div key={m.missionId} className="group bg-gray-900 rounded-2xl p-4 border border-white/5 flex items-center justify-between hover:border-blue-500/30 transition-all">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 bg-blue-500/10 rounded-xl flex items-center justify-center text-lg">🚀</div>
                    <div>
                      <div className="text-[10px] text-blue-400 font-black uppercase mb-0.5">MISSION</div>
                      <div className="text-sm text-white font-bold leading-tight">{m.title}</div>
                    </div>
                  </div>
                  <div className="text-gray-600 group-hover:text-white transition-colors">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center bg-gray-900/30 rounded-[2rem] border border-dashed border-white/10">
              <p className="text-gray-500 text-xs font-medium">현재 진행 중인 미션이 없습니다.</p>
              <Link href="/mission" className="inline-block mt-4 text-blue-400 text-xs font-black underline">새로운 미션 시작하기</Link>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
