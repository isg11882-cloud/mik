'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { createPost } from '../actions'
import type { CommunityCategory } from '@/lib/supabase/types'
import { clsx } from 'clsx'

const TAG_PRESETS = [
  '고프레임/신뢰감 회복',
  '환승이별/리바운드',
  '저프레임/의지부족',
  '갈등반복',
  '장기이별',
]

export default function NewPostPage() {
  const router = useRouter()
  const [category, setCategory] = useState<CommunityCategory>('forum')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tag, setTag] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const titleOk = title.trim().length >= 1 && title.trim().length <= 100
  const contentOk = content.trim().length >= 1 && content.trim().length <= 5000
  const canSubmit = titleOk && contentOk && !isPending

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      const res = await createPost({
        category,
        title: title.trim(),
        content: content.trim(),
        tag: tag || null,
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      router.push(`/community/${res.postId}`)
    })
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col max-w-md mx-auto pb-24 text-white">
      <header className="px-4 py-4 border-b border-gray-800 bg-gray-900/50 backdrop-blur sticky top-0 z-10 flex items-center gap-3">
        <button
          onClick={() => router.back()}
          className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white rounded-full bg-gray-800 transition"
          aria-label="뒤로"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h2 className="font-bold text-lg">새 글 쓰기</h2>
      </header>

      <form onSubmit={handleSubmit} className="p-5 space-y-5 flex-1">
        {/* 카테고리 */}
        <div>
          <label className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-2 block">
            카테고리
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setCategory('forum')}
              className={clsx(
                'flex-1 py-3 rounded-xl text-xs font-bold border transition-all',
                category === 'forum'
                  ? 'bg-blue-500/20 border-blue-500 text-blue-300'
                  : 'bg-gray-900 border-gray-800 text-gray-500',
              )}
            >
              💬 익명 고민
            </button>
            <button
              type="button"
              onClick={() => setCategory('story')}
              className={clsx(
                'flex-1 py-3 rounded-xl text-xs font-bold border transition-all',
                category === 'story'
                  ? 'bg-blue-500/20 border-blue-500 text-blue-300'
                  : 'bg-gray-900 border-gray-800 text-gray-500',
              )}
            >
              ✨ 성공 후기
            </button>
          </div>
        </div>

        {/* 태그 (선택) */}
        <div>
          <label className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-2 block">
            태그 (선택)
          </label>
          <div className="flex flex-wrap gap-2">
            {TAG_PRESETS.map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setTag(tag === t ? '' : t)}
                className={clsx(
                  'px-3 py-1.5 rounded-full text-[10px] font-bold border transition-all',
                  tag === t
                    ? 'bg-blue-500/20 border-blue-500 text-blue-300'
                    : 'bg-gray-900 border-gray-800 text-gray-500',
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* 제목 */}
        <div>
          <label className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-2 block">
            제목
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={100}
            placeholder="제목을 입력하세요 (최대 100자)"
            className="w-full bg-gray-800 text-white text-sm rounded-xl px-4 py-3 border border-gray-700 focus:border-blue-500 outline-none transition-colors"
          />
          <div className="text-[10px] text-gray-600 mt-1 text-right">{title.length} / 100</div>
        </div>

        {/* 본문 */}
        <div>
          <label className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-2 block">
            본문
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={5000}
            rows={12}
            placeholder="이 곳에 익명으로 자유롭게 적어보세요. 욕설이나 개인정보는 자제해 주세요."
            className="w-full bg-gray-800 text-white text-sm rounded-xl px-4 py-3 border border-gray-700 focus:border-blue-500 outline-none transition-colors resize-none leading-relaxed"
          />
          <div className="text-[10px] text-gray-600 mt-1 text-right">{content.length} / 5000</div>
        </div>

        {/* 안내 */}
        <p className="text-[10px] text-gray-500 leading-relaxed">
          ⚠️ 작성하신 글은 닉네임 대신 <strong>익명 핸들</strong> 로만 표시됩니다. 이메일·전화번호 등 개인정보 노출은 피해주세요.
        </p>

        {error && (
          <div className="p-3 rounded-xl bg-red-950/40 border border-red-500/30 text-red-300 text-xs">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={!canSubmit}
          className={clsx(
            'w-full py-4 rounded-xl font-bold text-sm transition-all',
            canSubmit
              ? 'bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white shadow-lg shadow-blue-900/30 active:scale-[0.98]'
              : 'bg-gray-800 text-gray-500 cursor-not-allowed',
          )}
        >
          {isPending ? '게시 중...' : '게시하기'}
        </button>
      </form>
    </div>
  )
}
