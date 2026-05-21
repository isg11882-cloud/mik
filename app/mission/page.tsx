'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'
import { useAppStore } from '@/lib/store'
import { MISSIONS, type Mission } from '@/lib/data/missions'
import { clsx } from 'clsx'

function MissionPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const filter = searchParams.get('filter')
  const { diagnosis, completedMissions, activeMissions, completeMission, isMissionCompleted } = useAppStore()
  
  const [selectedPhase, setSelectedPhase] = useState<number>(diagnosis?.phase || 1)
  const [selectedCategory, setSelectedCategory] = useState<string>('전체')
  
  // 현재 페이즈에 해당하는 카테고리 추출
  const categories = ['전체', ...Array.from(new Set(MISSIONS.filter(m => m.phase === selectedPhase).map(m => m.category)))]
  
  // 필터링된 미션 목록
  const filteredMissions = MISSIONS.filter(m => {
    const phaseMatch = m.phase === selectedPhase
    const categoryMatch = selectedCategory === '전체' || m.category === selectedCategory
    return phaseMatch && categoryMatch
  })

  const progress = Math.round((completedMissions.filter(cm => MISSIONS.find(m => m.id === cm.missionId)?.phase === selectedPhase).length / MISSIONS.filter(m => m.phase === selectedPhase).length) * 100)

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col max-w-md mx-auto pb-20">
      
      {/* Header */}
      <div className="px-6 pt-8 pb-4 bg-gradient-to-b from-gray-900 to-gray-950 sticky top-0 z-20">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-white mb-1">미션 센터</h1>
            <p className="text-gray-400 text-xs">재회 로드맵에 따른 단계별 미션</p>
          </div>
          <button 
            onClick={() => router.push('/dashboard')}
            className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center text-gray-400 hover:text-white transition"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
        </div>

        {/* Phase Selector */}
        <div className="flex bg-gray-800/50 p-1 rounded-xl mb-6">
          {[1, 2, 3].map(p => (
            <button
              key={p}
              onClick={() => { setSelectedPhase(p); setSelectedCategory('전체'); }}
              className={clsx(
                "flex-1 py-2 text-sm font-bold rounded-lg transition-all",
                selectedPhase === p ? "bg-blue-600 text-white shadow-lg" : "text-gray-500 hover:text-gray-300"
              )}
            >
              PHASE {p}
            </button>
          ))}
        </div>

        {/* Category Filter */}
        {filter !== 'active' && (
          <div className="flex gap-2 overflow-x-auto pb-2 no-scrollbar">
            {categories.map(cat => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={clsx(
                  "px-4 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all border",
                  selectedCategory === cat 
                    ? "bg-blue-500/20 border-blue-500 text-blue-400" 
                    : "bg-gray-900 border-gray-800 text-gray-500"
                )}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Progress Section */}
      {filter !== 'active' && (
        <div className="px-6 mb-6">
          <div className="glass p-5 rounded-2xl border border-gray-800/50 bg-gradient-to-br from-gray-900 to-blue-950/20">
            <div className="flex justify-between items-end mb-2">
              <span className="text-sm font-bold text-white">PHASE {selectedPhase} 진행도</span>
              <span className="text-xl font-black text-blue-400">{progress}%</span>
            </div>
            <div className="h-2 w-full bg-gray-800 rounded-full overflow-hidden">
              <div 
                className="h-full bg-blue-500 transition-all duration-1000 ease-out shadow-[0_0_10px_rgba(59,130,246,0.5)]"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Mission List */}
      <div className="px-6 space-y-4">
        {filter === 'active' && activeMissions.length > 0 && (
          <div className="mb-4">
            <h2 className="text-sm font-bold text-blue-400 mb-2">🎯 현재 진행 중인 미션</h2>
          </div>
        )}
        
        {filter === 'active' 
          ? activeMissions.map(am => {
              // 정적 미션 정보 찾기 (없을 수도 있음 - AI 생성 미션)
              const staticMission = MISSIONS.find(m => m.id === am.missionId)
              return (
                <div key={am.missionId} className="glass p-5 rounded-2xl border border-blue-500/50 bg-blue-950/10 hover:border-blue-500 transition-all">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-xl flex-shrink-0 bg-blue-900/50 text-blue-400">
                      🎯
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-bold text-blue-500 uppercase tracking-tighter">진행중</span>
                      </div>
                      <h3 className="text-white font-bold text-sm mb-1">{am.title}</h3>
                      <p className="text-gray-400 text-xs leading-relaxed mb-4">
                        {staticMission?.description || 'AI가 추천한 맞춤형 미션입니다.'}
                      </p>
                      <button 
                        onClick={() => {
                          if (confirm(`'${am.title}' 미션을 완료하셨나요?`)) {
                            completeMission(am.missionId)
                          }
                        }}
                        className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-lg transition-colors shadow-lg shadow-blue-900/20"
                      >
                        완료 체크하기
                      </button>
                    </div>
                  </div>
                </div>
              )
            })
          : filteredMissions.map(mission => {
            const isCompleted = isMissionCompleted(mission.id)
            return (
              <div 
                key={mission.id}
                className={clsx(
                  "glass p-5 rounded-2xl border transition-all relative overflow-hidden group",
                  isCompleted 
                    ? "border-green-500/30 bg-green-950/10 opacity-80" 
                    : "border-gray-800/50 hover:border-gray-700"
                )}
              >
                {isCompleted && (
                  <div className="absolute top-0 right-0 p-3">
                    <div className="bg-green-500 text-white p-1 rounded-full">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                    </div>
                  </div>
                )}
                
                <div className="flex items-start gap-4">
                  <div className={clsx(
                    "w-12 h-12 rounded-xl flex items-center justify-center text-xl flex-shrink-0",
                    isCompleted ? "bg-green-500/20" : "bg-gray-800"
                  )}>
                    {mission.category === '무연락 유지' ? '📵' : 
                     mission.category === '감정 정리' ? '📝' : 
                     mission.category === '이별 분석' ? '🔍' : 
                     mission.category === 'SNS 관리' ? '📸' : 
                     mission.category === '외적 변화' ? '👔' : 
                     mission.category === '내적 성장' ? '🧘' : 
                     mission.category === '사회적 확장' ? '🤝' : 
                     mission.category === 'SNS 전략' ? '📱' : '🎯'}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-bold text-blue-500 uppercase tracking-tighter">{mission.category}</span>
                      <span className={clsx(
                        "text-[9px] px-1.5 py-0.5 rounded border font-bold uppercase",
                        mission.difficulty === 'easy' ? "border-green-500/30 text-green-500" :
                        mission.difficulty === 'medium' ? "border-yellow-500/30 text-yellow-500" :
                        "border-red-500/30 text-red-500"
                      )}>
                        {mission.difficulty}
                      </span>
                    </div>
                    <h3 className="text-white font-bold text-sm mb-1">{mission.title}</h3>
                    <p className="text-gray-400 text-xs leading-relaxed mb-4">
                      {mission.description}
                    </p>
                    
                    {!isCompleted ? (
                      <button 
                        onClick={() => {
                          if (confirm(`'${mission.title}' 미션을 완료하셨나요?`)) {
                            completeMission(mission.id)
                          }
                        }}
                        className="w-full py-2 bg-gray-800 hover:bg-blue-600 text-white text-xs font-bold rounded-lg transition-colors border border-gray-700"
                      >
                        완료 체크하기
                      </button>
                    ) : (
                      <div className="text-center py-2 text-green-500 text-xs font-bold">
                        미션 완료 ✨ (+{mission.points}pt)
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        }

        {filter !== 'active' && filteredMissions.length === 0 && (
          <div className="py-20 text-center">
            <div className="text-4xl mb-4 opacity-20">🍃</div>
            <p className="text-gray-500 text-sm font-medium">이 카테고리에는 아직 미션이 없습니다.</p>
          </div>
        )}
        
        {filter === 'active' && activeMissions.length === 0 && (
          <div className="py-20 text-center">
            <div className="text-4xl mb-4 opacity-20">🎯</div>
            <p className="text-gray-500 text-sm font-medium">현재 진행 중인 미션이 없습니다.</p>
            <button onClick={() => router.push('/mission')} className="mt-4 px-4 py-2 bg-gray-800 rounded-full text-xs font-bold hover:bg-gray-700 text-white">전체 미션 보기</button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function MissionPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-950 flex items-center justify-center text-white">로딩 중...</div>}>
      <MissionPageContent />
    </Suspense>
  )
}
