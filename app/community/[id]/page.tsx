import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createSupabaseServer } from '@/lib/supabase/server'
import LikeButton from './_components/LikeButton'
import CommentForm from './_components/CommentForm'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function PostDetailPage({ params }: PageProps) {
  const { id } = await params
  const supabase = await createSupabaseServer()

  // 동시 fetch
  const [{ data: { user } }, postRes, commentsRes] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from('community_posts')
      .select('id, author_id, anon_handle, category, title, content, tag, likes_count, comments_count, created_at, is_hidden')
      .eq('id', id)
      .maybeSingle(),
    supabase
      .from('community_comments')
      .select('id, author_id, anon_handle, content, is_ai, created_at')
      .eq('post_id', id)
      .eq('is_hidden', false)
      .order('created_at', { ascending: true }),
  ])

  const post = postRes.data
  if (!post || post.is_hidden) notFound()

  // 본인 좋아요 여부
  let initialLiked = false
  if (user) {
    const { data: likeRow } = await supabase
      .from('community_likes')
      .select('post_id')
      .eq('user_id', user.id)
      .eq('post_id', id)
      .maybeSingle()
    initialLiked = !!likeRow
  }

  const isOwner = !!user && user.id === post.author_id
  const comments = commentsRes.data ?? []

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col max-w-md mx-auto pb-24 text-white">
      {/* Header */}
      <header className="px-4 py-4 border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-10 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href={`/community?tab=${post.category}`}
            className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white rounded-full bg-gray-800 transition flex-shrink-0"
            aria-label="목록으로"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </Link>
          <h2 className="font-bold text-sm truncate">
            {post.category === 'story' ? '성공 후기' : '익명 고민 광장'}
          </h2>
        </div>
        {isOwner && <DeleteAction postId={post.id} />}
      </header>

      <main className="p-5 space-y-6">
        {/* 게시글 본문 */}
        <article className="space-y-5">
          {post.tag && (
            <span className="inline-block px-3 py-1 bg-white/5 text-gray-400 text-[10px] font-black rounded-full border border-white/5">
              {post.tag}
            </span>
          )}
          <h1 className="text-2xl font-black leading-tight">{post.title}</h1>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-gray-800 flex items-center justify-center text-[10px]">
                👤
              </div>
              <span className="font-bold">{post.anon_handle}</span>
            </div>
            <span>·</span>
            <span>{formatDateTime(post.created_at)}</span>
          </div>
          <div className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
            {post.content}
          </div>
        </article>

        {/* 좋아요 */}
        <div className="flex items-center justify-center pt-4 border-t border-white/5">
          <LikeButton
            postId={post.id}
            initialLiked={initialLiked}
            initialCount={post.likes_count}
            isLoggedIn={!!user}
          />
        </div>

        {/* 댓글 */}
        <section className="space-y-4">
          <h3 className="text-sm font-black flex items-center gap-2">
            💬 댓글 <span className="text-gray-500 font-medium">{post.comments_count}</span>
          </h3>

          <CommentForm postId={post.id} isLoggedIn={!!user} />

          <div className="space-y-3 mt-6">
            {comments.length === 0 ? (
              <div className="py-8 text-center text-xs text-gray-500">
                아직 댓글이 없어요. 첫 응원을 남겨보세요.
              </div>
            ) : (
              comments.map((c) => (
                <div
                  key={c.id}
                  className={`rounded-2xl p-4 border ${
                    c.is_ai
                      ? 'bg-purple-950/20 border-purple-500/30'
                      : 'bg-gray-900/50 border-white/5'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    {c.is_ai && (
                      <span className="px-2 py-0.5 bg-purple-500/20 text-purple-300 text-[9px] font-black rounded-full border border-purple-500/30">
                        AI
                      </span>
                    )}
                    <span className="text-[11px] font-bold text-gray-400">{c.anon_handle}</span>
                    <span className="text-[10px] text-gray-600 ml-auto">
                      {formatDateTime(c.created_at)}
                    </span>
                  </div>
                  <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
                    {c.content}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

// ─────────────────────────────────────────────
// 작성자 본인의 삭제 버튼 (Server Action 인라인 form)
// ─────────────────────────────────────────────
function DeleteAction({ postId }: { postId: string }) {
  return (
    <form
      action={async () => {
        'use server'
        const { deletePost } = await import('../actions')
        await deletePost(postId)
      }}
    >
      <button
        type="submit"
        className="text-[10px] font-bold text-red-400/70 hover:text-red-400 px-3 py-1.5 rounded-full border border-red-500/20 hover:border-red-500/40 transition-colors"
      >
        삭제
      </button>
    </form>
  )
}

function formatDateTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const today = new Date()
  if (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  ) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}
