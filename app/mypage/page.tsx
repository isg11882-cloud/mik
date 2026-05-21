'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { createSupabaseBrowser } from '@/lib/supabase/client'
import NicknameEditor from './_components/NicknameEditor'

export default function MyPage() {
  const router = useRouter()
  const supabase = createSupabaseBrowser()
  const {
    nickname,
    diagnosis,
    totalPoints,
    chatCount,
    completedMissions,
    emotions,
    user,
    resetAll,
  } = useAppStore()

  const handleLogout = async () => {
    if (!confirm('로그아웃하시겠습니까? 이 기기의 진단/상담 내역은 그대로 남아 있습니다.')) return
    await supabase.auth.signOut()
    // user 상태는 AuthObserver가 onAuthStateChange로 갱신
    router.push('/dashboard')
  }

  // 레벨 계산 (임시 로직: 200포인트당 1레벨)
  const level = Math.floor(totalPoints / 200) + 1
  const nextLevelProgress = (totalPoints % 200) / 200 * 100

  const recentMissions = [...completedMissions].reverse().slice(0, 3)

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col max-w-md mx-auto pb-24 text-white">
      
      {/* Header & Profile */}
      <div className="px-6 pt-12 pb-8 bg-gradient-to-b from-blue-900/20 to-gray-950 rounded-b-[3rem] border-b border-white/5">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-3xl shadow-xl shadow-blue-500/20">
            👤
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <NicknameEditor
                initial={nickname || (user?.email?.split('@')[0]) || '재회 희망자'}
                isLoggedIn={!!user}
              />
              <span className="bg-blue-600 text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-widest flex-shrink-0">LV.{level}</span>
            </div>
            <p className="text-gray-400 text-xs truncate">
              {diagnosis ? `${diagnosis.title} 유형 · PHASE ${diagnosis.phase}` : '진단 전입니다.'}
            </p>
          </div>
        </div>

        {/* 진단 결과 다시 보기 / 다시 받기 */}
        <div className="grid grid-cols-2 gap-2 mb-4">
          {diagnosis ? (
            <Link
              href="/diagnosis/result"
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-gray-900/60 border border-white/5 rounded-xl text-[11px] font-bold text-gray-300 hover:text-white hover:border-blue-500/40 transition-colors"
            >
              📊 내 리포트 보기
            </Link>
          ) : (
            <Link
              href="/diagnosis"
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-blue-600/20 border border-blue-500/40 rounded-xl text-[11px] font-bold text-blue-300 hover:bg-blue-600/30 transition-colors col-span-2"
            >
              🔍 무료 진단 시작하기
            </Link>
          )}
          {diagnosis && (
            <Link
              href="/diagnosis"
              className="flex items-center justify-center gap-1.5 px-3 py-2.5 bg-gray-900/60 border border-white/5 rounded-xl text-[11px] font-bold text-gray-400 hover:text-white hover:border-white/20 transition-colors"
            >
              🔄 다시 진단받기
            </Link>
          )}
        </div>

        {/* 계정 상태: 로그인 / 비로그인 분기 */}
        {user ? (
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-900/60 border border-white/5 rounded-2xl">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-[10px] font-black text-green-400 uppercase tracking-widest">Synced</div>
                <div className="text-[11px] text-gray-300 truncate">{user.email ?? '계정 연결됨'}</div>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="text-[10px] font-bold text-gray-400 hover:text-red-400 px-3 py-1.5 rounded-full border border-white/10 hover:border-red-500/40 transition-colors flex-shrink-0"
            >
              로그아웃
            </button>
          </div>
        ) : (
          <button
            onClick={() => router.push('/login?reason=save-report&next=/mypage')}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-gradient-to-r from-blue-600/20 to-purple-600/20 border border-blue-500/30 rounded-2xl hover:border-blue-400 transition-colors text-left"
          >
            <div>
              <div className="text-[10px] font-black text-blue-400 uppercase tracking-widest">Guest Mode</div>
              <div className="text-[11px] text-gray-300">계정 연결로 모든 데이터 영구 보관</div>
            </div>
            <span className="text-blue-300 text-xs font-black">로그인 →</span>
          </button>
        )}

        {/* Level Stats */}
        <div className="space-y-2">
          <div className="flex justify-between text-[10px] font-bold text-blue-400 uppercase tracking-widest px-1">
            <span>Next Level</span>
            <span>{Math.round(nextLevelProgress)}%</span>
          </div>
          <div className="h-2 w-full bg-white/5 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-blue-600 to-blue-400 transition-all duration-1000" 
              style={{ width: `${nextLevelProgress}%` }}
            />
          </div>
        </div>
      </div>

      {/* Grid Stats */}
      <div className="px-6 -mt-6 grid grid-cols-3 gap-3 mb-8">
        {[
          { label: '포인트', value: totalPoints, unit: 'pt', icon: '💎' },
          { label: '상담', value: chatCount, unit: '회', icon: '🤖' },
          { label: '미션', value: completedMissions.length, unit: '개', icon: '🎯' },
        ].map(stat => (
          <div key={stat.label} className="bg-gray-900/80 backdrop-blur border border-white/5 p-3 rounded-2xl text-center shadow-lg">
            <div className="text-lg mb-1">{stat.icon}</div>
            <div className="text-sm font-black text-white">{stat.value}<span className="text-[10px] ml-0.5 text-gray-500">{stat.unit}</span></div>
            <div className="text-[9px] text-gray-500 font-bold uppercase tracking-widest">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Emotion Graph Section */}
      <div className="px-6 mb-8">
        <div className="flex justify-between items-end mb-4 px-1">
          <h3 className="font-bold text-sm flex items-center gap-2">
            <span>📈</span> 감정 회복 트래킹
          </h3>
          <span className="text-[10px] text-gray-500 font-medium">최근 7일 기준</span>
        </div>
        <div className="glass p-5 rounded-3xl border border-white/5 min-h-[160px] flex items-end justify-between gap-2">
          {emotions.length > 0 ? (
            emotions.slice(-7).map((e, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-2">
                <div 
                  className="w-full bg-gradient-to-t from-blue-600 to-blue-400 rounded-t-lg transition-all duration-1000"
                  style={{ height: `${e.score * 20}%`, minHeight: '4px' }}
                />
                <span className="text-[8px] text-gray-500 font-bold">{e.date.split('-').slice(1).join('/')}</span>
              </div>
            ))
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center py-4 text-gray-600">
              <span className="text-2xl mb-2">📊</span>
              <p className="text-[10px] text-center">아직 감정 기록이 없습니다.<br/>매일 체크인하여 변화를 확인하세요.</p>
            </div>
          )}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="px-6 mb-8">
        <h3 className="font-bold text-sm mb-4 px-1 flex items-center gap-2">
          <span>🔔</span> 최근 완료 미션
        </h3>
        <div className="space-y-3">
          {recentMissions.length > 0 ? (
            recentMissions.map((m, i) => (
              <div key={i} className="flex items-center gap-3 bg-gray-900/50 p-3 rounded-xl border border-white/5">
                <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center text-green-500 text-sm">✅</div>
                <div className="flex-1">
                  <div className="text-[11px] font-bold text-white leading-tight">미션 완료</div>
                  <div className="text-[9px] text-gray-500 mt-0.5">{new Date(m.completedAt).toLocaleDateString()}</div>
                </div>
              </div>
            ))
          ) : (
            <div className="text-center py-6 bg-gray-900/30 rounded-2xl border border-dashed border-gray-800">
              <p className="text-[10px] text-gray-500">완료한 미션이 없습니다.</p>
            </div>
          )}
        </div>
      </div>

      {/* Settings / Danger Zone */}
      <div className="px-6 mt-4">
        <button 
          onClick={() => {
            if (confirm('모든 진단 데이터와 상담 내역이 삭제됩니다. 정말 초기화하시겠습니까?')) {
              resetAll()
              router.push('/')
            }
          }}
          className="w-full py-4 text-xs font-bold text-red-500/70 hover:text-red-500 transition-colors border border-red-500/10 rounded-2xl bg-red-500/5"
        >
          서비스 데이터 초기화
        </button>
      </div>
    </div>
  )
}
