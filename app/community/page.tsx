import Link from 'next/link'
import { createSupabaseServer } from '@/lib/supabase/server'
import CommunityTabs from './_components/CommunityTabs'
import WriteButton from './_components/WriteButton'
import type { CommunityCategory, Tables } from '@/lib/supabase/types'

// 목록 SELECT 컬럼만 선택적으로 picking — 전체 row 가 아니라 일부만 fetch
type Post = Pick<
  Tables<'community_posts'>,
  | 'id'
  | 'anon_handle'
  | 'category'
  | 'title'
  | 'content'
  | 'tag'
  | 'likes_count'
  | 'comments_count'
  | 'created_at'
>

interface PageProps {
  searchParams: Promise<{ tab?: string }>
}

export default async function CommunityPage({ searchParams }: PageProps) {
  const params = await searchParams
  const tab: CommunityCategory = params.tab === 'forum' ? 'forum' : 'story'

  const supabase = await createSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: posts } = await supabase
    .from('community_posts')
    .select('id, anon_handle, category, title, content, tag, likes_count, comments_count, created_at')
    .eq('category', tab)
    .eq('is_hidden', false)
    .order('created_at', { ascending: false })
    .limit(30)

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col max-w-md mx-auto pb-24 text-white">
      <header className="px-6 pt-12 pb-6 border-b border-white/5 bg-gray-950/50 backdrop-blur-xl sticky top-0 z-50">
        <h1 className="text-2xl font-black italic mb-6">Community</h1>
        <CommunityTabs active={tab} />
      </header>

      <main className="p-6">
        {tab === 'story' ? (
          <StorySection posts={posts ?? []} />
        ) : (
          <ForumSection posts={posts ?? []} isLoggedIn={!!user} />
        )}
      </main>
    </div>
  )
}

// ─────────────────────────────────────────────
function StorySection({ posts }: { posts: Post[] }) {
  return (
    <div className="space-y-6">
      <div className="bg-blue-600/10 border border-blue-500/20 p-4 rounded-2xl mb-4">
        <p className="text-[10px] text-blue-400 font-black uppercase tracking-widest mb-1">
          Success Archive
        </p>
        <p className="text-xs text-gray-300 leading-tight">
          검증된 재회 성공 사례를 읽고 희망을 얻으세요.
        </p>
      </div>

      {posts.length === 0 ? (
        <EmptyState message="아직 등록된 후기가 없어요. 첫 후기를 남겨주세요." />
      ) : (
        posts.map((post) => (
          <Link
            key={post.id}
            href={`/community/${post.id}`}
            className="block group bg-gray-900 rounded-[2rem] p-6 border border-white/5 hover:border-blue-500/30 transition-all shadow-xl active:scale-[0.98]"
          >
            <div className="flex justify-between items-start mb-4">
              <span className="px-3 py-1 bg-white/5 text-gray-400 text-[10px] font-black rounded-full border border-white/5">
                {post.tag ?? '후기'}
              </span>
              <span className="text-[10px] text-gray-600 font-medium">
                {formatDate(post.created_at)}
              </span>
            </div>
            <h3 className="text-lg font-black mb-3 leading-tight group-hover:text-blue-400 transition-colors">
              {post.title}
            </h3>
            <p className="text-gray-400 text-sm mb-6 line-clamp-2 leading-relaxed">
              {post.content}
            </p>
            <div className="flex justify-between items-center pt-4 border-t border-white/5">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-full bg-gray-800 flex items-center justify-center text-[10px]">
                  👤
                </div>
                <span className="text-xs text-gray-500 font-bold">{post.anon_handle}</span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-pink-500 font-bold">❤️ {post.likes_count}</span>
                <span className="text-blue-400 font-bold">💬 {post.comments_count}</span>
              </div>
            </div>
          </Link>
        ))
      )}
    </div>
  )
}

// ─────────────────────────────────────────────
function ForumSection({ posts, isLoggedIn }: { posts: Post[]; isLoggedIn: boolean }) {
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-sm font-black text-gray-400">최근 올라온 고민</h2>
        <WriteButton isLoggedIn={isLoggedIn} />
      </div>

      {posts.length === 0 ? (
        <EmptyState message="아직 글이 없어요. 첫 고민을 익명으로 털어놔도 좋아요." />
      ) : (
        posts.map((post) => (
          <Link
            key={post.id}
            href={`/community/${post.id}`}
            className="flex justify-between items-center bg-gray-900/50 rounded-2xl p-5 border border-white/5 active:bg-gray-900 transition-all"
          >
            <div className="space-y-2 flex-1 min-w-0">
              <h3 className="text-sm font-bold text-gray-200 truncate">{post.title}</h3>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-gray-600 font-bold">{post.anon_handle}</span>
                <span className="text-[10px] text-blue-500 font-black">
                  💬 {post.comments_count}
                </span>
                <span className="text-[10px] text-pink-500 font-black">
                  ❤️ {post.likes_count}
                </span>
              </div>
            </div>
            <div className="text-gray-700 ml-3 flex-shrink-0">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </Link>
        ))
      )}

      <div className="mt-12 p-8 text-center bg-gray-900/20 rounded-[2rem] border border-dashed border-white/10">
        <p className="text-gray-500 text-xs font-medium italic">
          당신의 고민을 익명으로 털어놓으세요.<br />
          수많은 재회 동료들이 당신을 응원합니다.
        </p>
      </div>
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-16 text-center bg-gray-900/30 rounded-[2rem] border border-dashed border-white/10">
      <div className="text-3xl mb-3 opacity-30">📝</div>
      <p className="text-gray-500 text-xs font-medium leading-relaxed">{message}</p>
    </div>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}
