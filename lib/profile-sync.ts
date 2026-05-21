/**
 * profile-sync.ts
 * ────────────────────────────────────────────────
 * 진단 결과 / 이별 날짜 / 상황 메모를 Supabase `profiles` 테이블에
 * 캐시(저장)하고, 반대로 서버 캐시를 zustand 로컬 store 로 복원하는 유틸.
 *
 * 핵심 정책 (Phase 1):
 *  - 충돌 시 "클라이언트 우선" — 새로 받은 진단이 항상 우선
 *  - profiles 캐시는 "AI 컨텍스트 주입(Phase 2)을 위한 빠른 1쿼리 소스"
 *  - 진단 이력 보관(diagnosis_results 테이블)은 lib/sync.ts 가 책임짐
 *  - 실패해도 throw 하지 않음 (진단/로그인 흐름을 막지 말 것)
 *
 * days_since_breakup 의 시간 의존성:
 *  - profiles.breakup_date(DATE) 만이 진실 (정확한 날짜 입력이 있을 때)
 *  - profiles.days_since_breakup 는 진단 당시 기준 캐시일 뿐
 *  - AI 컨텍스트 주입 시점에 CURRENT_DATE - breakup_date 로 재계산 (Phase 2)
 */

import { createSupabaseBrowser } from './supabase/client'
import type { TablesInsert } from './supabase/types'
import { useAppStore, type DiagnosisResult } from './store'

// ────────────────────────────────────────────────
// 타입
// ────────────────────────────────────────────────
export interface ProfileCachePayload {
  diagnosis: DiagnosisResult | null
  breakupDate: string | null   // YYYY-MM-DD
  situationMemo?: string | null
}

export interface ProfileRow {
  id: string
  nickname: string | null
  anon_handle: string | null
  total_points: number | null
  chat_count: number | null
  current_phase: number | null
  breakup_date: string | null
  breakup_type: 'A' | 'B' | 'C' | 'D' | null
  days_since_breakup: number | null
  diagnosis_summary: string | null
  situation_memo: string | null
  last_diagnosis_at: string | null
}

// 호출 결과 — 호출자가 후속 동작을 결정할 수 있도록
export type SyncResult =
  | { ok: true; skipped?: boolean }
  | { ok: false; error: unknown }

// ────────────────────────────────────────────────
// 1) 진단/이별 날짜 → profiles 캐시 (클라이언트 → 서버)
// ────────────────────────────────────────────────
/**
 * 진단 결과와 이별 날짜를 profiles 에 upsert.
 * - userId: auth.users.id
 * - 진단/날짜가 둘 다 없으면 no-op (skipped: true)
 *
 * RLS: profiles 의 users_own_profile 정책으로 본인 row 만 수정 가능.
 */
export async function syncDiagnosisToProfile(
  userId: string,
  payload: ProfileCachePayload,
): Promise<SyncResult> {
  const { diagnosis, breakupDate, situationMemo } = payload

  // 보낼 게 없으면 스킵
  if (!diagnosis && !breakupDate && situationMemo == null) {
    return { ok: true, skipped: true }
  }

  // upsert payload (id는 PK, 나머지는 부분 갱신)
  const updates: TablesInsert<'profiles'> = {
    id: userId,
    updated_at: new Date().toISOString(),
  }

  if (diagnosis) {
    updates.breakup_type = diagnosis.breakupType
    updates.days_since_breakup = diagnosis.daysSinceBreakup
    updates.current_phase = diagnosis.phase
    updates.diagnosis_summary = diagnosis.summary
    updates.last_diagnosis_at = new Date().toISOString()
  }

  if (breakupDate) {
    // YYYY-MM-DD 만 허용 (postgres DATE 타입과 호환)
    updates.breakup_date = breakupDate
  }

  if (situationMemo !== undefined) {
    updates.situation_memo = situationMemo
  }

  try {
    const supabase = createSupabaseBrowser()
    const { error } = await supabase
      .from('profiles')
      .upsert(updates, { onConflict: 'id' })

    if (error) throw error
    return { ok: true }
  } catch (err) {
    console.error('[profile-sync] syncDiagnosisToProfile failed:', err)
    return { ok: false, error: err }
  }
}

// ────────────────────────────────────────────────
// 2) profiles → 로컬 store (서버 → 클라이언트)
// ────────────────────────────────────────────────
/**
 * Supabase profiles row 를 가져와 zustand store 에 반영한다.
 * 충돌 정책: 클라이언트에 이미 진단 데이터가 있으면 덮어쓰지 않는다.
 *  - 즉, "다른 기기에서 로그인한 직후 store가 비어 있을 때"만 복원이 의미를 가짐
 *  - 같은 기기에서 진단을 막 끝낸 직후 로그인 → 클라이언트 데이터 보존
 *
 * 반환: 서버 row 또는 null (없거나 에러).
 */
export async function fetchProfileToLocal(userId: string): Promise<ProfileRow | null> {
  try {
    const supabase = createSupabaseBrowser()
    const { data, error } = await supabase
      .from('profiles')
      .select(
        'id, nickname, anon_handle, total_points, chat_count, current_phase, breakup_date, breakup_type, days_since_breakup, diagnosis_summary, situation_memo, last_diagnosis_at',
      )
      .eq('id', userId)
      .maybeSingle()

    if (error) throw error
    if (!data) return null

    const row = data as ProfileRow
    const state = useAppStore.getState()

    // ── 닉네임/포인트/상담횟수: 클라이언트가 비어있을 때만 복원
    const patch: Partial<{
      nickname: string
      totalPoints: number
      chatCount: number
    }> = {}
    if (!state.nickname && row.nickname) patch.nickname = row.nickname
    if (state.totalPoints === 0 && row.total_points) patch.totalPoints = row.total_points
    if (state.chatCount === 0 && row.chat_count) patch.chatCount = row.chat_count
    if (Object.keys(patch).length > 0) useAppStore.setState(patch)

    // ── 진단 결과: 클라이언트에 진단이 없을 때만 복원
    //    (있으면 클라이언트 우선 — 다음 sync 시점에 서버로 push)
    if (!state.diagnosis && row.breakup_type && row.current_phase) {
      const restoredDiagnosis: DiagnosisResult = {
        breakupType: row.breakup_type,
        scores: { A: 0, B: 0, C: 0, D: 0 }, // scores 는 캐시에 없음 — 0 으로 채움
        phase: (row.current_phase as 1 | 2 | 3) ?? 1,
        title: titleFromType(row.breakup_type),
        summary: row.diagnosis_summary ?? '',
        successRate: successRateFromType(row.breakup_type),
        daysSinceBreakup: row.days_since_breakup ?? 0,
      }
      useAppStore.setState({ diagnosis: restoredDiagnosis })
    }

    // ── 이별 날짜: 클라이언트에 없으면 복원
    if (!state.breakupDate && row.breakup_date) {
      useAppStore.setState({ breakupDate: row.breakup_date })
    }

    return row
  } catch (err) {
    console.error('[profile-sync] fetchProfileToLocal failed:', err)
    return null
  }
}

// ────────────────────────────────────────────────
// 3) 게스트 → 로그인 마이그레이션 (양방향 머지)
// ────────────────────────────────────────────────
/**
 * 로그인 직후 한 번 호출.
 *  1. 클라이언트 store 에 진단 결과가 있으면 → profiles 에 push (덮어쓰기)
 *  2. 그 후 profiles 에서 fetch → store 에 부족한 부분 복원
 *
 * 두 번 왕복하는 이유:
 *  - 새 기기 로그인 시 store가 비어있다면 (1)은 no-op, (2)에서 복원됨
 *  - 게스트로 진단 후 로그인했다면 (1)에서 push, (2)에서는 충돌없이 본인 데이터 그대로
 */
export async function reconcileProfileOnLogin(userId: string): Promise<void> {
  const state = useAppStore.getState()

  // 1) 로컬에 있는 진단/날짜를 서버로 push
  await syncDiagnosisToProfile(userId, {
    diagnosis: state.diagnosis,
    breakupDate: state.breakupDate,
  })

  // 2) 서버에서 다시 가져와 빈 곳 복원
  await fetchProfileToLocal(userId)
}

// ────────────────────────────────────────────────
// 보조 — 진단 캐시에 없는 정적 메타(title, successRate)를 type 에서 추론
// (diagnosis_results 테이블에는 저장되지만, profiles 캐시에는 두지 않음)
// ────────────────────────────────────────────────
function titleFromType(type: 'A' | 'B' | 'C' | 'D'): string {
  return {
    A: '감정소진형',
    B: '갈등반복형',
    C: '대체자형',
    D: '장기이별형',
  }[type]
}

function successRateFromType(type: 'A' | 'B' | 'C' | 'D'): string {
  return {
    A: '재회 가능성 높음',
    B: '노력 여하에 따라 가능',
    C: '시간과 전략 필요',
    D: '접근 방식이 관건',
  }[type]
}
