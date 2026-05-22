'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { syncDiagnosisToProfile } from '@/lib/profile-sync'

const QUESTIONS = [
  {
    id: 1,
    text: '이별을 공식적으로 먼저 선언하고 관계를 정리한 주체는 누구인가요?',
    options: [
      { id: 1, text: '상대방이 일방적으로 관계를 정리하자고 통보했다' },
      { id: 2, text: '내가 지쳐서 혹은 홧김에 먼저 이별을 선언했다' },
      { id: 3, text: '서로 감정이 식어 대화를 통해 차분하게 합의하여 헤어졌다' },
      { id: 4, text: '피할 수 없는 현실적 상황과 압박 때문에 자연스레 멀어졌다' },
    ]
  },
  {
    id: 2,
    text: '상대방이 당신과의 이별을 최종 결심한 가장 결정적인 심리학적 계기는 무엇인가요?',
    options: [
      { id: 1, text: '나의 잦은 투정/애정 테스트/서운함 분출로 상대방이 감정적으로 완전히 지치고 소진되었다 (매력 소진)' },
      { id: 2, text: '가치관이나 성격 차이로 인한 소모적인 말다툼이 끝없이 반복되며 신뢰를 상실했다 (갈등 반복)' },
      { id: 3, text: '상대방에게 다른 새로운 이성(대체자)이 출현하여 관계의 무게추가 급격히 기울었다 (대체자 출현)' },
      { id: 4, text: '장거리, 취업/이직, 집안 반대 등 현실적 장벽에 부딪혀 관계를 지속할 미래를 잃었다 (현실 장벽)' },
    ]
  },
  {
    id: 3,
    text: '이별이 임박한 시점, 두 사람 사이에 흘렀던 분위기와 기류는 어땠나요?',
    options: [
      { id: 1, text: '몇 주 혹은 몇 달 전부터 연락 빈도와 대화 깊이가 현저히 줄어들며 냉담해졌다' },
      { id: 2, text: '사소한 일로 갑자기 대판 싸운 뒤, 극단적인 감정 상태에서 홧김에 갑자기 이별을 선언했다' },
      { id: 3, text: '상대방 혹은 나의 명백한 신뢰 저해 행동(거짓말, 바람, 약속 위반 등)으로 파국을 맞이했다' },
      { id: 4, text: '서로 눈물을 흘리며 슬퍼했지만, 현실적 문제 때문에 어쩔 수 없이 안녕을 고했다' },
    ]
  },
  {
    id: 4,
    text: '현재 두 사람 사이의 연락 및 소통 상태는 객관적으로 어떠한가요?',
    options: [
      { id: 1, text: '전화, 카톡, SNS 등이 모두 차단되어 일체 연락할 길이 막혀 있다' },
      { id: 2, text: '사적인 안부는 일절 나누지 않으며, 공무/업무/물건 반환 등 공적인 필수 연락만 미니멀하게 한다' },
      { id: 3, text: '이별을 받아들이지 못해 내가 전화를 걸거나 붙잡았을 때, 상대가 마지못해 간헐적으로 응답한다' },
      { id: 4, text: '이별은 했지만 편안한 친구처럼 안부 정도는 부담 없이 가볍게 주고받는다' },
    ]
  },
  {
    id: 5,
    text: '헤어진 후, 상대방의 카톡 프로필이나 SNS(인스타그램 등)는 어떻게 변화하고 있나요?',
    options: [
      { id: 1, text: '새로운 연인이 생긴 듯한 흔적을 내거나, 다른 이성과 호감을 나누는 티를 드러내고 있다' },
      { id: 2, text: '나와 관련되었던 모든 흔적을 깨끗이 정리하고, 아무렇지 않게 매우 잘 사는 모습을 활발히 전시한다' },
      { id: 3, text: '평소와 다름없이 고요하고 변화가 없는 일상을 조용히 유지하고 있다' },
      { id: 4, text: '프로필을 다 내리고 기본 이미지로 설정하거나, 슬프고 힘든 심리를 암시하는 듯한 흔적을 풍긴다' },
    ]
  },
  {
    id: 6,
    text: '연애 중일 때, 두 분의 다툼 빈도나 갈등 해결 방식은 어떠했나요?',
    options: [
      { id: 1, text: '거의 싸우지 않고 서로 맞춰가며 아주 평화롭게 지냈다' },
      { id: 2, text: '평소엔 잘 지내다가도 가끔 한 번씩 걷잡을 수 없이 크게 폭발하며 싸웠다' },
      { id: 3, text: '사소하고 일상적인 오해나 서운함 때문에 쳇바퀴 돌듯 자주 부딪히고 싸웠다' },
      { id: 4, text: '마음에 걸리는 것이 있어도 직면하지 않고 회피하거나 가슴속에 꾹꾹 억누르는 편이었다' },
    ]
  },
  {
    id: 7,
    text: '헤어진 날로부터 오늘까지 경과된 기간은 정확히 얼마나 되었나요?',
    options: [
      { id: 1, text: '아직 1주일도 되지 않은 아주 극단적인 초기의 이별 상태' },
      { id: 2, text: '1주일에서 1달 이내로, 아직 감정의 여파가 남아 있는 혼돈의 시기' },
      { id: 3, text: '1달에서 3달 사이로, 슬슬 일상에 적응하며 서로의 소중함이나 부재를 실감할 때' },
      { id: 4, text: '3달 이상의 장기 이별 상태로, 서로의 단점보다는 미화된 옛 추억이 조용히 살아날 때' },
    ]
  },
  {
    id: 8,
    text: '이별 후 현재, 나를 대하는 상대방의 현실적인 반응과 태도의 온도는 어떠한가요?',
    options: [
      { id: 1, text: '나의 대화 시도나 안부에 대해 한 치의 틈도 주지 않고 극도로 차갑고 냉정하게 선을 긋는다' },
      { id: 2, text: '연락이나 붙잡음에 대해 극심한 거부감, 피로감, 혹은 분노를 서슴지 않고 표출한다' },
      { id: 3, text: '새로운 연애나 취미에 몰두하여 나라는 존재에 대해 완전히 무관심해진 느낌이 든다' },
      { id: 4, text: '헤어진 후에도 가벼운 여운을 남기며, 미안함이나 일말의 죄책감을 표현하거나 씁쓸해한다' },
    ]
  },
  {
    id: 9,
    text: '이별을 겪은 지금, 나의 내면에서 불어오는 재회 의지는 어느 정도인가요?',
    options: [
      { id: 1, text: '자존심을 다 버려도 좋으니, 무슨 수를 써서라도 무조건 상대를 다시 잡고 싶다' },
      { id: 2, text: '도전할 수 있는 만큼 최선을 다해 잡아보고, 그래도 전혀 안 된다면 후련하게 포기하고 싶다' },
      { id: 3, text: '이별의 고통과 심리적 타격이 너무 극심하여, 관계에서 벗어나 나를 먼저 지키고 안정을 찾고 싶다' },
      { id: 4, text: '혼자선 올바른 판단을 내릴 수 없어, 재회 전문가의 철저하게 객관적이고 과학적인 분석을 원한다' },
    ]
  }
]

// 한 단계 추가: Q9 이후 "정확한 이별 날짜(선택)" 입력
const TOTAL_STEPS = QUESTIONS.length + 1 // 9문항 + 날짜 입력

export default function DiagnosisPage() {
  const router = useRouter()
  const [currentQ, setCurrentQ] = useState(0)
  const [answers, setAnswers] = useState<Record<number, number>>({})
  const [breakupDateInput, setBreakupDateInput] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const setDiagnosis = useAppStore(s => s.setDiagnosis)
  const setBreakupDate = useAppStore(s => s.setBreakupDate)
  const clearChatHistory = useAppStore(s => s.clearChatHistory)

  const isDateStep = currentQ >= QUESTIONS.length
  const question = QUESTIONS[currentQ]
  const progress = Math.round(((currentQ + 1) / TOTAL_STEPS) * 100)

  const handleSelect = (optionId: number) => {
    if (!question) return
    setAnswers(prev => ({ ...prev, [question.id]: optionId }))
  }

  const handleNext = async () => {
    if (currentQ < TOTAL_STEPS - 1) {
      setCurrentQ(prev => prev + 1)
    } else {
      await submitDiagnosis()
    }
  }

  const handlePrev = () => {
    if (currentQ > 0) setCurrentQ(prev => prev - 1)
  }

  const submitDiagnosis = async () => {
    setIsSubmitting(true)

    // 1) 정확한 날짜 입력이 있으면 정밀 계산, 없으면 Q7 기반 근사치 fallback
    const daysMap = { 1: 3, 2: 15, 3: 45, 4: 100 }
    let daysSinceBreakup = daysMap[answers[7] as keyof typeof daysMap] || 0

    if (breakupDateInput) {
      const t = new Date(breakupDateInput).getTime()
      if (Number.isFinite(t)) {
        const diffDays = Math.max(0, Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24)))
        daysSinceBreakup = diffDays
        setBreakupDate(breakupDateInput)
      }
    }

    try {
      const res = await fetch('/api/diagnosis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, daysSinceBreakup })
      })

      if (!res.ok) throw new Error('API Error')

      const result = await res.json()

      const diagnosisPayload = {
        breakupType: result.breakupType,
        scores: result.scores,
        phase: result.phase,
        title: result.title,
        summary: result.summary,
        successRate: result.successRate,
        daysSinceBreakup: result.daysSinceBreakup,
      }
      setDiagnosis(diagnosisPayload)
      clearChatHistory()

      // 로그인 상태이면 profiles 캐시도 동기화 (fire-and-forget — 결과 페이지로 즉시 이동)
      // 실패해도 다음 로그인 시 reconcileProfileOnLogin 이 보정함
      const userId = useAppStore.getState().user?.id
      if (userId) {
        void syncDiagnosisToProfile(userId, {
          diagnosis: diagnosisPayload,
          breakupDate: breakupDateInput || null,
        })
      }

      router.push('/diagnosis/result')
    } catch (error) {
      console.error(error)
      alert('진단 중 오류가 발생했습니다. 다시 시도해 주세요.')
      setIsSubmitting(false)
    }
  }

  // 오늘 날짜(input max 제한)
  const todayIso = new Date().toISOString().split('T')[0]

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col max-w-md mx-auto">
      
      {/* Top Bar */}
      <div className="flex items-center px-4 py-4 border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-10">
        <button onClick={() => router.push('/')} className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white rounded-full bg-gray-800 transition">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <h2 className="ml-3 font-bold text-lg text-white">현황 진단</h2>
      </div>

      {/* Progress */}
      <div className="px-5 py-4 bg-gray-900/30">
        <div className="flex justify-between text-xs text-slate-400 mb-2 font-medium">
          <span>{isDateStep ? '마지막 단계 (선택)' : `진단 ${currentQ + 1} / ${QUESTIONS.length}`}</span>
          <span>{progress}%</span>
        </div>
        <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Step Body */}
      <div className="flex-1 p-5 overflow-y-auto">
        {isDateStep ? (
          // ─── 마지막 단계: 정확한 이별 날짜 (선택 입력) ───
          <div className="glass p-6 rounded-2xl shadow-lg border border-gray-800/50 fade-in-up" key="date-step">
            <div className="text-xs font-bold text-blue-400 mb-3 tracking-widest font-mono">FINAL STEP · OPTIONAL</div>
            <h3 className="text-xl font-bold text-white mb-2 leading-relaxed">
              정확한 이별 날짜를 알려주실 수 있나요?
            </h3>
            <p className="text-sm text-gray-400 leading-relaxed mb-6">
              날짜를 입력하면 D-day와 PHASE 판단 정확도가 올라갑니다.
              건너뛰셔도 7번 문항을 기준으로 자동 추정해요.
            </p>

            <div className="relative mb-3">
              <input
                type="date"
                max={todayIso}
                value={breakupDateInput}
                onChange={(e) => setBreakupDateInput(e.target.value)}
                onClick={(e) => {
                  try {
                    e.currentTarget.showPicker()
                  } catch (err) {
                    console.warn('DatePicker showPicker not supported', err)
                  }
                }}
                style={{ colorScheme: 'dark' }}
                className="w-full bg-gray-800 text-white text-sm rounded-xl pl-4 pr-12 py-3.5 border border-gray-700 focus:border-blue-500 outline-none transition-all cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer"
              />
              <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </div>
            </div>

            {breakupDateInput && (
              <div className="text-[11px] text-blue-300 font-bold">
                {(() => {
                  const days = Math.max(0, Math.floor((Date.now() - new Date(breakupDateInput).getTime()) / (1000 * 60 * 60 * 24)))
                  return `→ 이별 후 ${days}일 경과`
                })()}
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                // 건너뛰기 = 입력값 무시하고 즉시 진단 결과로 이동 (Q7 기반 자동 추정 사용)
                setBreakupDateInput('')
                submitDiagnosis()
              }}
              disabled={isSubmitting}
              className="mt-4 text-[11px] text-gray-500 hover:text-gray-300 underline disabled:opacity-50"
            >
              건너뛰기 (자동 추정으로 결과 보기 →)
            </button>
          </div>
        ) : (
          // ─── 일반 문항 ───
          <div className="glass p-6 rounded-2xl shadow-lg border border-gray-800/50 fade-in-up" key={currentQ}>
            <div className="text-xs font-bold text-blue-400 mb-3 tracking-widest font-mono">QUESTION {String(currentQ + 1).padStart(2, '0')}</div>
            <h3 className="text-xl font-bold text-white mb-6 leading-relaxed">
              {question.text}
            </h3>

            <div className="space-y-3">
              {question.options.map(opt => {
                const isSelected = answers[question.id] === opt.id
                return (
                  <button
                    key={opt.id}
                    onClick={() => handleSelect(opt.id)}
                    className={`w-full text-left p-4 rounded-xl border transition-all duration-200 text-sm font-medium ${
                      isSelected
                        ? 'border-blue-500 bg-blue-500/10 text-blue-100 shadow-[0_0_15px_rgba(59,130,246,0.15)] ring-1 ring-blue-500/50'
                        : 'border-gray-700 bg-gray-800/50 text-gray-300 hover:border-gray-600 hover:bg-gray-800'
                    }`}
                  >
                    {opt.text}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Nav */}
      <div className="p-5 flex gap-3 bg-gray-900/80 backdrop-blur border-t border-gray-800">
        {currentQ > 0 && (
          <button
            onClick={handlePrev}
            className="px-6 py-3 rounded-xl border border-gray-700 bg-gray-800 text-white font-medium hover:bg-gray-700 transition w-1/3"
            disabled={isSubmitting}
          >
            이전
          </button>
        )}
        <button
          onClick={handleNext}
          // 날짜 단계는 미입력도 허용(선택), 일반 문항은 답변 필수
          disabled={(!isDateStep && !answers[question?.id]) || isSubmitting}
          className={`py-3 rounded-xl font-bold transition flex-1 flex justify-center items-center ${
            (isDateStep || answers[question?.id]) && !isSubmitting
              ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20'
              : 'bg-gray-800 text-gray-500 cursor-not-allowed'
          }`}
        >
          {isSubmitting ? (
            <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
          ) : currentQ === TOTAL_STEPS - 1 ? (
            '진단 결과 보기 →'
          ) : (
            '다음 →'
          )}
        </button>
      </div>

    </div>
  )
}
