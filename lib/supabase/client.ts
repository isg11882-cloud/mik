/**
 * 브라우저(Client Component)용 Supabase 클라이언트
 *
 * - createBrowserClient: 자동으로 document.cookie 를 읽고 써서
 *   Supabase 인증 세션을 동기화. RLS 의 auth.uid() 가 정상 동작.
 * - 싱글톤: 한 탭에 1개만 유지하여 onAuthStateChange 리스너 중복 방지.
 *
 * 안전망 (2026-05-06):
 *  - 환경변수 누락 시 throw 하지 않음 (페이지 자체가 죽으면 사용자가 어떤 버튼도 못 누름)
 *  - 대신 isSupabaseConfigured() 로 호출자가 사전 체크 가능
 *  - 누락 상태에서 호출 시 콘솔에 명확한 에러 + 정상 client 리턴 (실제 호출은 실패)
 */

import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './types'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

let _client: SupabaseClient<Database> | null = null
let _warnedOnce = false

/**
 * 환경변수가 모두 설정되어 있어 정상 동작 가능한지 확인.
 * 로그인 버튼 클릭 핸들러 등에서 사전 체크 후 사용자에게 안내 가능.
 */
export function isSupabaseConfigured(): boolean {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return false
  // JWT 포맷(점 2개) 검증하여 플레이스홀더나 엉뚱한 API Key 차단
  return SUPABASE_ANON_KEY.split('.').length === 3
}

export function createSupabaseBrowser(): SupabaseClient<Database> {
  if (_client) return _client

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    if (!_warnedOnce) {
      _warnedOnce = true
      console.error(
        '[supabase] 환경변수 누락 — Vercel Settings → Environment Variables 에서 ' +
          'NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 를 확인하고 ' +
          'Redeploy(Use existing Build Cache 체크 해제) 해주세요.',
      )
    }
    // 의도적 fallback — 정상 client 처럼 동작하지만 실제 요청은 실패.
    // 페이지 자체가 죽지 않게 하기 위함.
    _client = createBrowserClient<Database>(
      SUPABASE_URL || 'https://missing-env.supabase.co',
      SUPABASE_ANON_KEY || 'missing-anon-key',
    )
    return _client
  }

  _client = createBrowserClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY)
  return _client
}
