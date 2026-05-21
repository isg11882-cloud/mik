'use server'

/**
 * 커뮤니티 Server Actions
 *
 * 모든 쓰기 경로 (글 작성 / 댓글 작성 / 좋아요 토글) 의 단일 진입점.
 * - RLS 검증을 서버에서 수행
 * - 익명 핸들은 profiles.anon_handle 을 서버에서 직접 SELECT 하여 사용 (클라 위조 차단)
 * - 성공 시 revalidatePath 로 관련 페이지 재생성
 */

import { createSupabaseServer } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { CommunityCategory } from '@/lib/supabase/types'

// ────────────────────────────────────────────────
// 공통 — 본인 정보 조회
// ────────────────────────────────────────────────
async function getCurrentUserAndHandle() {
  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: '로그인이 필요합니다.' as const }

  const { data: profile, error: pErr } = await supabase
    .from('profiles')
    .select('anon_handle')
    .eq('id', user.id)
    .maybeSingle()

  if (pErr || !profile?.anon_handle) {
    return { error: '프로필을 찾을 수 없습니다. 잠시 후 다시 시도해 주세요.' as const }
  }
  return { user, anonHandle: profile.anon_handle, supabase }
}

// ────────────────────────────────────────────────
// 1) 글 작성
// ────────────────────────────────────────────────
export interface CreatePostInput {
  category: CommunityCategory
  title: string
  content: string
  tag?: string | null
}

export type CreatePostResult =
  | { ok: true; postId: string }
  | { ok: false; error: string }

export async function createPost(input: CreatePostInput): Promise<CreatePostResult> {
  // 입력 검증 (DB CHECK 제약과 동일)
  const title = input.title?.trim() ?? ''
  const content = input.content?.trim() ?? ''
  if (title.length < 1 || title.length > 100) {
    return { ok: false, error: '제목은 1~100자 사이여야 합니다.' }
  }
  if (content.length < 1 || content.length > 5000) {
    return { ok: false, error: '본문은 1~5000자 사이여야 합니다.' }
  }
  if (input.category !== 'story' && input.category !== 'forum') {
    return { ok: false, error: '카테고리가 올바르지 않습니다.' }
  }

  const ctx = await getCurrentUserAndHandle()
  if ('error' in ctx) return { ok: false, error: ctx.error as string }
  const { user, anonHandle, supabase } = ctx

  const { data, error } = await supabase
    .from('community_posts')
    .insert({
      author_id: user.id,
      anon_handle: anonHandle,
      category: input.category,
      title,
      content,
      tag: input.tag?.trim() || null,
    })
    .select('id')
    .single()

  if (error || !data) {
    console.error('[createPost] failed:', error)
    return { ok: false, error: error?.message ?? '글 작성에 실패했습니다.' }
  }

  revalidatePath('/community')
  return { ok: true, postId: data.id }
}

// ────────────────────────────────────────────────
// 2) 댓글 작성
// ────────────────────────────────────────────────
export interface CreateCommentInput {
  postId: string
  content: string
}

export async function createComment(input: CreateCommentInput) {
  const content = input.content?.trim() ?? ''
  if (content.length < 1 || content.length > 1000) {
    return { ok: false as const, error: '댓글은 1~1000자 사이여야 합니다.' }
  }

  const ctx = await getCurrentUserAndHandle()
  if ('error' in ctx) return { ok: false as const, error: ctx.error as string }
  const { user, anonHandle, supabase } = ctx

  const { error } = await supabase
    .from('community_comments')
    .insert({
      post_id: input.postId,
      author_id: user.id,
      anon_handle: anonHandle,
      content,
      is_ai: false,
    })

  if (error) {
    console.error('[createComment] failed:', error)
    return { ok: false as const, error: error.message }
  }

  revalidatePath(`/community/${input.postId}`)
  revalidatePath('/community')
  return { ok: true as const }
}

// ────────────────────────────────────────────────
// 3) 좋아요 토글 (INSERT 시도 → unique 충돌이면 DELETE)
// ────────────────────────────────────────────────
export async function toggleLike(postId: string): Promise<{ ok: true; liked: boolean } | { ok: false; error: string }> {
  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: '로그인이 필요합니다.' }

  // 현재 상태 확인
  const { data: existing } = await supabase
    .from('community_likes')
    .select('post_id')
    .eq('user_id', user.id)
    .eq('post_id', postId)
    .maybeSingle()

  if (existing) {
    const { error } = await supabase
      .from('community_likes')
      .delete()
      .eq('user_id', user.id)
      .eq('post_id', postId)
    if (error) return { ok: false, error: error.message }
    revalidatePath(`/community/${postId}`)
    return { ok: true, liked: false }
  } else {
    const { error } = await supabase
      .from('community_likes')
      .insert({ user_id: user.id, post_id: postId })
    if (error) return { ok: false, error: error.message }
    revalidatePath(`/community/${postId}`)
    return { ok: true, liked: true }
  }
}

// ────────────────────────────────────────────────
// 4) 글 삭제 (작성자 본인만 — RLS 가 추가 검증)
// ────────────────────────────────────────────────
export async function deletePost(postId: string) {
  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, error: '로그인이 필요합니다.' }

  const { error } = await supabase
    .from('community_posts')
    .delete()
    .eq('id', postId)
    .eq('author_id', user.id)

  if (error) return { ok: false as const, error: error.message }
  revalidatePath('/community')
  redirect('/community')
}
