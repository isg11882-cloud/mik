import 'server-only'

/**
 * Supabase Admin (service_role) 클라이언트
 *
 * ⚠️ RLS 를 우회하는 강력한 키. 절대 클라이언트 번들에 포함되면 안 됩니다.
 *  - 환경변수: SUPABASE_SERVICE_ROLE_KEY (NEXT_PUBLIC_ 접두어 금지)
 *  - 'server-only' import 로 Client Component import 시 빌드 에러 발생.
 *
 * 사용 시점 (Phase 3 예정):
 *  - AI 모더레이터가 community_comments 에 is_ai=true 로 자동 댓글 작성
 *  - 관리자 도구 (게시물 숨기기 등)
 *  - 시스템 작업 (배치, 마이그레이션)
 *
 * 일반 사용자 요청 처리 흐름에서는 절대 사용하지 마세요.
 * 사용자 권한이 필요한 작업은 createSupabaseServer() 로 충분합니다.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './types'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

let _admin: SupabaseClient<Database> | null = null

/**
 * service_role 키로 RLS 를 우회하는 admin 클라이언트를 반환.
 * 키가 없으면 명확한 에러를 던집니다 (Vercel 환경변수 누락 조기 감지).
 */
export function createSupabaseAdmin(): SupabaseClient<Database> {
  if (_admin) return _admin

  if (!SUPABASE_URL) {
    throw new Error('[supabase/admin] NEXT_PUBLIC_SUPABASE_URL 가 설정되지 않았습니다.')
  }
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      '[supabase/admin] SUPABASE_SERVICE_ROLE_KEY 가 설정되지 않았습니다. ' +
        'Supabase Dashboard → Project Settings → API → service_role 키를 .env.local 에 추가하세요. ' +
        '(NEXT_PUBLIC_ 접두어 금지)',
    )
  }

  _admin = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      // 서버 전용 — 세션 저장/갱신 비활성
      persistSession: false,
      autoRefreshToken: false,
    },
  })
  return _admin
}
