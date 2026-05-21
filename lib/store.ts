/**
 * 재회컨설팅 앱 — Zustand 로컬 상태 관리
 * MVP 단계: Supabase 대신 로컬 스토리지로 데이터 유지
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { MISSIONS } from './data/missions'

export type BreakupType = 'A' | 'B' | 'C' | 'D'

export interface DiagnosisResult {
  breakupType: BreakupType
  scores: Record<BreakupType, number>
  phase: 1 | 2 | 3
  title: string
  summary: string
  successRate: string
  daysSinceBreakup: number
}

export interface EmotionEntry {
  date: string
  score: number // 1~5
  label: string
}

export interface MissionCompletion {
  missionId: string
  title: string
  completedAt: string
  pointsEarned: number
  note?: string
}

export interface ActiveMission {
  missionId: string
  startedAt: string
  title: string
}

// 동적(AI 추천) 미션의 기본 포인트
const DYNAMIC_MISSION_DEFAULT_POINTS = 50

interface AppState {
  // 사용자 프로필
  nickname: string
  setNickname: (name: string) => void

  // 진단 결과
  diagnosis: DiagnosisResult | null
  setDiagnosis: (result: DiagnosisResult) => void

  // 이별 날짜
  breakupDate: string | null
  setBreakupDate: (date: string) => void

  // 감정 체크인
  emotions: EmotionEntry[]
  addEmotion: (entry: EmotionEntry) => void

  // 미션 완료 및 진행
  activeMissions: ActiveMission[]
  startMission: (missionId: string, title: string) => void
  completedMissions: MissionCompletion[]
  completeMission: (missionId: string, note?: string) => void
  isMissionCompleted: (missionId: string) => boolean
  isMissionActive: (missionId: string) => boolean
  isMissionActiveByTitle: (title: string) => boolean
  isMissionCompletedByTitle: (title: string) => boolean

  // 마지막 Supabase 동기화 시점 (멱등성 가드)
  lastSyncedAt: string | null
  setLastSyncedAt: (iso: string | null) => void

  // 로그인 프롬프트 쿨다운 (의미 있는 데이터가 쌓인 시점에만 1회 권유)
  lastLoginPromptedAt: string | null
  markLoginPrompted: () => void

  // 포인트
  totalPoints: number
  addPoints: (pts: number) => void

  // 스트릭
  streakDays: number

  // 상담 횟수
  chatCount: number
  incrementChatCount: () => void

  // 상담 내역 저장
  chatHistory: Array<{ id: string; role: 'user' | 'assistant'; content: string; isError?: boolean }>
  setChatHistory: (messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; isError?: boolean }>) => void
  clearChatHistory: () => void

  // 유저 세션
  user: any | null
  setUser: (user: any) => void

  // 리셋
  resetAll: () => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      nickname: '',
      setNickname: (name) => set({ nickname: name }),

      user: null,
      setUser: (user) => set({ user }),

      diagnosis: null,
      setDiagnosis: (result) => set({ diagnosis: result }),

      breakupDate: null,
      setBreakupDate: (date) => set({ breakupDate: date }),

      emotions: [],
      addEmotion: (entry) => set((s) => ({
        emotions: [...s.emotions.slice(-29), entry], // 최대 30일 보관
      })),

      activeMissions: [],
      startMission: (missionId, title) => set((s) => ({
        activeMissions: s.activeMissions.some(m => m.missionId === missionId) 
          ? s.activeMissions 
          : [...s.activeMissions, { missionId, title, startedAt: new Date().toISOString() }]
      })),

      completedMissions: [],
      completeMission: (missionId, note) => set((s) => {
        // 정적 미션이면 데이터에서 실제 포인트/타이틀 조회, 동적(AI 추천) 미션이면 activeMissions의 title + 기본 포인트 사용
        const staticMission = MISSIONS.find(m => m.id === missionId)
        const active = s.activeMissions.find(m => m.missionId === missionId)
        const title = staticMission?.title ?? active?.title ?? '미션'
        const pointsEarned = staticMission?.points ?? DYNAMIC_MISSION_DEFAULT_POINTS

        const alreadyCompleted = s.completedMissions.some(m => m.missionId === missionId)
        if (alreadyCompleted) {
          return {
            activeMissions: s.activeMissions.filter(m => m.missionId !== missionId),
          }
        }

        return {
          activeMissions: s.activeMissions.filter(m => m.missionId !== missionId),
          completedMissions: [...s.completedMissions, {
            missionId,
            title,
            completedAt: new Date().toISOString(),
            pointsEarned,
            note,
          }],
          totalPoints: s.totalPoints + pointsEarned,
        }
      }),
      isMissionCompleted: (missionId) =>
        get().completedMissions.some((m) => m.missionId === missionId),
      isMissionActive: (missionId) =>
        get().activeMissions.some((m) => m.missionId === missionId),
      isMissionActiveByTitle: (title) =>
        get().activeMissions.some((m) => m.title === title),
      isMissionCompletedByTitle: (title) =>
        get().completedMissions.some((m) => m.title === title),

      lastSyncedAt: null,
      setLastSyncedAt: (iso) => set({ lastSyncedAt: iso }),

      lastLoginPromptedAt: null,
      markLoginPrompted: () => set({ lastLoginPromptedAt: new Date().toISOString() }),

      totalPoints: 0,
      addPoints: (pts) => set((s) => ({ totalPoints: s.totalPoints + pts })),

      streakDays: 0,

      chatCount: 0,
      incrementChatCount: () => set((s) => ({ chatCount: s.chatCount + 1 })),

      chatHistory: [],
      setChatHistory: (messages) => set({ chatHistory: messages }),
      clearChatHistory: () => set({ chatHistory: [] }),

      resetAll: () => set({
        nickname: '',
        diagnosis: null,
        breakupDate: null,
        emotions: [],
        activeMissions: [],
        completedMissions: [],
        totalPoints: 0,
        streakDays: 0,
        chatCount: 0,
        chatHistory: [],
        lastSyncedAt: null,
        lastLoginPromptedAt: null,
      }),
    }),
    {
      name: 'reunion-app-storage',
    }
  )
)
