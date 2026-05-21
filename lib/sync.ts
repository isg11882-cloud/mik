import { createSupabaseBrowser } from './supabase/client'
import { useAppStore } from './store'

/**
 * 로컬 데이터를 Supabase DB로 마이그레이션하는 유틸리티
 *
 * 멱등성 전략:
 * - profiles: PK가 user_id이므로 항상 upsert 안전.
 * - diagnosis_results: lastSyncedAt 이후에 새로 받은 진단만 한 번 insert.
 *   (현재 store는 진단을 한 번만 보관하므로, 이미 동기화된 적이 있으면 skip)
 * - chat_history / user_missions: lastSyncedAt(이전 동기화 시점) 이후 새로 추가된 항목만 insert.
 *   타임스탬프가 메시지 객체에 없으면 안전을 위해 skip.
 */
export async function syncLocalDataToSupabase(userId: string) {
  const supabase = createSupabaseBrowser()
  const state = useAppStore.getState()
  const lastSyncedAt = state.lastSyncedAt ? new Date(state.lastSyncedAt).getTime() : 0
  const nowIso = new Date().toISOString()

  try {
    // 1. 프로필 upsert (멱등)
    if (state.nickname || state.totalPoints > 0 || state.diagnosis) {
      await supabase.from('profiles').upsert({
        id: userId,
        nickname: state.nickname,
        total_points: state.totalPoints,
        chat_count: state.chatCount,
        current_phase: state.diagnosis?.phase || 1,
        updated_at: nowIso,
      })
    }

    // 2. 진단 결과 — 처음 동기화일 때만 insert
    if (state.diagnosis && lastSyncedAt === 0) {
      await supabase.from('diagnosis_results').insert({
        user_id: userId,
        breakup_type: state.diagnosis.breakupType,
        phase: state.diagnosis.phase,
        title: state.diagnosis.title,
        summary: state.diagnosis.summary,
        success_rate: state.diagnosis.successRate,
        days_since_breakup: state.diagnosis.daysSinceBreakup,
      })
    }

    // 3. 채팅 내역 — id가 timestamp 기반이라고 가정하고, lastSyncedAt 이후 메시지만 insert
    if (state.chatHistory.length > 0) {
      const newMessages = state.chatHistory.filter(msg => {
        const ts = Number(msg.id)
        return Number.isFinite(ts) && ts > lastSyncedAt && ts > 1000000000000
      })

      if (newMessages.length > 0) {
        const historyToUpload = newMessages.map(msg => ({
          user_id: userId,
          role: msg.role,
          content: msg.content,
          is_error: msg.isError || false,
          created_at: new Date(Number(msg.id)).toISOString(),
        }))
        await supabase.from('chat_history').insert(historyToUpload)
      }
    }

    // 4. 진행 중 미션 — startedAt 기준으로 신규만 insert
    if (state.activeMissions.length > 0) {
      const newMissions = state.activeMissions.filter(m => {
        const startedTs = new Date(m.startedAt).getTime()
        return Number.isFinite(startedTs) && startedTs > lastSyncedAt
      })

      if (newMissions.length > 0) {
        const missionsToUpload = newMissions.map(m => ({
          user_id: userId,
          mission_id: m.missionId,
          title: m.title,
          status: 'active' as const,
          started_at: m.startedAt,
        }))
        await supabase.from('user_missions').insert(missionsToUpload)
      }
    }

    // 동기화 시점 기록
    useAppStore.getState().setLastSyncedAt(nowIso)
    console.log('[Sync Success] Local data migrated to Supabase.')
    return true
  } catch (error) {
    console.error('[Sync Error] Failed to migrate data:', error)
    return false
  }
}

/**
 * @deprecated `fetchProfileToLocal` (lib/profile-sync.ts) 를 사용하세요.
 * 진단 캐시 복원/충돌 정책까지 포함된 통합 버전입니다.
 *
 * 본 함수는 외부에서 import 하는 곳이 없을 때 다음 정리 PR 에서 제거 예정.
 */
export async function fetchUserDataToLocal(userId: string) {
  const { fetchProfileToLocal } = await import('./profile-sync')
  await fetchProfileToLocal(userId)
}
