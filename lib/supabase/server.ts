import 'server-only'

/**
 * 서버 측 Supabase 클라이언트
 *  - Server Component
 *  - Route Handler (Node 또는 Edge runtime)
 *  - Server Action
 *
 * Next.js 15: cookies() 가 async 로 변경됨 → 본 헬퍼도 async 함수.
 * @supabase/ssr 0.5+: getAll / setAll 시그니처 표준.
 *
 * Edge Runtime 호환:
 *  - next/headers 의 cookies() 는 Edge 에서도 동작
 *  - 따라서 `/api/chat` (export const runtime = 'edge') 에서도 그대로 사용 가능
 *
 * 사용 예 (Route Handler):
 *   export async function GET(request: Request) {
 *     const supabase = await createSupabaseServer()
 *     const { data: { user } } = await supabase.auth.getUser()
 *     ...
 *   }
 *
 * 'server-only' import 로 Client Component 가 잘못 import 하면 빌드 시점에 에러.
 */

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './types'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export async function createSupabaseServer(): Promise<SupabaseClient<Database>> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error(
      '[supabase] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 가 설정되지 않았습니다.',
    )
  }

  const cookieStore = await cookies()

  return createServerClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options)
          })
        } catch {
          // Server Component 컨텍스트에서는 cookies() 가 read-only 라 set 이 throw.
          // middleware 가 세션 갱신을 담당하면 이는 무시 가능.
          // (Route Handler / Server Action 에서는 정상 동작)
        }
      },
    },
  })
}
