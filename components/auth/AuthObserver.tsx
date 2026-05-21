'use client'

import { useEffect } from 'react'
import { createSupabaseBrowser, isSupabaseConfigured } from '@/lib/supabase/client'
import { syncLocalDataToSupabase } from '@/lib/sync'
import { reconcileProfileOnLogin } from '@/lib/profile-sync'
import { useAppStore } from '@/lib/store'

/**
 * AuthObserver
 * ────────────────────────────────────────────────
 * Supabase auth 상태 변화를 감지하여:
 *   - SIGNED_IN  → 진단/이별 날짜를 profiles 캐시에 push 후 재복원 (양방향 머지)
 *                  + 채팅/미션 이력을 diagnosis_results / chat_history / user_missions 에 push
 *   - SIGNED_OUT → user 상태 비우기 (로컬 데이터는 유지: 게스트 모드 fallback)
 */
export default function AuthObserver() {
  const setUser = useAppStore((s) => s.setUser)

  useEffect(() => {
    // 환경변수 누락 시 supabase init 자체를 건너뜀 (게스트 모드 동작 유지)
    if (!isSupabaseConfigured()) {
      console.warn('[AuthObserver] Supabase 환경변수 누락 — 인증 감시 비활성화 (게스트 모드)')
      return
    }
    const supabase = createSupabaseBrowser()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      setUser(session?.user || null)

      if (event === 'SIGNED_IN' && session?.user) {
        const userId = session.user.id
        console.log('[Auth] User signed in:', userId)

        // ── Phase 1 핵심: profiles 캐시 양방향 머지
        //    1) 클라이언트 진단/날짜 → 서버 push
        //    2) 서버 → 빈 곳만 복원 (클라이언트 우선)
        await reconcileProfileOnLogin(userId)

        // ── 광범위 마이그레이션 (chat_history, user_missions, diagnosis_results 이력)
        //    lastSyncedAt 가드로 중복 insert 방지
        await syncLocalDataToSupabase(userId)
      }

      if (event === 'SIGNED_OUT') {
        console.log('[Auth] User signed out')
        // 로컬 store 데이터는 유지 — 같은 기기에서 게스트 모드로 사용 가능
        // 명시적으로 비우려면 useAppStore.getState().resetAll() 호출
      }
    })

    return () => {
      subscription.unsubscribe()
    }
    // supabase / setUser 는 모듈 스코프 / zustand 셀렉터로 안정적이므로 deps 없이 1회만 구독
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
