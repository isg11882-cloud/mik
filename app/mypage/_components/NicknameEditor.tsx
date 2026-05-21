'use client'

import { useState, useTransition } from 'react'
import { useAppStore } from '@/lib/store'
import { createSupabaseBrowser } from '@/lib/supabase/client'
import { clsx } from 'clsx'

/**
 * 마이페이지 헤더의 닉네임 인라인 편집.
 * - 표시 모드: 현재 닉네임 + ✏️
 * - 편집 모드: input + 저장/취소
 * - 저장 시 profiles.update + zustand store 동기화
 *
 * 비로그인 / 진단 전 게스트는 zustand 만 갱신 (DB write 없음)
 */
export default function NicknameEditor({ initial, isLoggedIn }: { initial: string; isLoggedIn: boolean }) {
  const setNickname = useAppStore((s) => s.setNickname)
  const user = useAppStore((s) => s.user)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const open = () => {
    setDraft(initial)
    setError(null)
    setEditing(true)
  }

  const cancel = () => {
    setEditing(false)
    setError(null)
  }

  const save = () => {
    const trimmed = draft.trim()
    if (trimmed.length === 0) {
      setError('닉네임을 입력해주세요.')
      return
    }
    if (trimmed.length > 20) {
      setError('닉네임은 20자 이내로 입력해주세요.')
      return
    }
    if (trimmed === initial) {
      setEditing(false)
      return
    }

    startTransition(async () => {
      // 항상 zustand 갱신 — 즉시 반영
      setNickname(trimmed)

      // 로그인 사용자는 profiles 동기화
      if (isLoggedIn && user?.id) {
        const supabase = createSupabaseBrowser()
        const { error: dbError } = await supabase
          .from('profiles')
          .update({ nickname: trimmed, updated_at: new Date().toISOString() })
          .eq('id', user.id)

        if (dbError) {
          setError(dbError.message)
          return
        }
      }
      setEditing(false)
    })
  }

  if (!editing) {
    return (
      <button
        onClick={open}
        className="group flex items-center gap-1.5 hover:opacity-80 transition-opacity"
        title="닉네임 변경"
      >
        <span className="text-xl font-black truncate max-w-[180px]">{initial}</span>
        <span className="text-[10px] text-gray-500 group-hover:text-blue-400 transition-colors">✏️</span>
      </button>
    )
  }

  return (
    <div className="flex flex-col gap-1 w-full">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={20}
          placeholder="닉네임"
          autoFocus
          className="flex-1 min-w-0 bg-gray-800 text-white text-base font-bold rounded-lg px-3 py-1.5 border border-blue-500 outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') cancel()
          }}
        />
        <button
          onClick={save}
          disabled={isPending}
          className={clsx(
            'px-3 py-1.5 rounded-lg text-[11px] font-black transition-colors flex-shrink-0',
            isPending
              ? 'bg-gray-700 text-gray-500'
              : 'bg-blue-600 hover:bg-blue-500 text-white',
          )}
        >
          {isPending ? '...' : '저장'}
        </button>
        <button
          onClick={cancel}
          disabled={isPending}
          className="px-2 py-1.5 rounded-lg text-[11px] font-bold text-gray-400 hover:text-white transition-colors flex-shrink-0"
        >
          취소
        </button>
      </div>
      <div className="flex items-center justify-between text-[10px] mt-0.5">
        <span className={error ? 'text-red-400' : 'text-gray-600'}>
          {error ?? '한글/영문 1~20자'}
        </span>
        <span className="text-gray-600">{draft.length} / 20</span>
      </div>
    </div>
  )
}
