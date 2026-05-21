-- ──────────────────────────────────────────────────
-- Phase 1 마이그레이션 (2026-05-05)
-- 적용 방법: Supabase Dashboard → SQL Editor 에 통째로 붙여넣고 RUN
--
-- 포함 내용:
--   1. profiles 확장 (진단 결과 캐시 + 익명 핸들)
--   2. 익명 핸들 생성 함수 + 가입 트리거 갱신
--   3. community_posts / community_comments / community_likes
--   4. likes_count / comments_count 동기화 트리거
--   5. updated_at 자동 갱신 트리거
--   6. RLS 정책
--
-- 모든 문장은 IF NOT EXISTS / OR REPLACE / DROP IF EXISTS 로 작성되어
-- 여러 번 실행해도 안전합니다.
-- ──────────────────────────────────────────────────

-- ─────────────────────────────────────────
-- 1) profiles 확장
--    - anon_handle: 익명 게시판 표시용 핸들 (예: "익명-A1B2C3")
--    - 진단 결과 캐시 컬럼: AI 컨텍스트에 1쿼리로 주입하기 위함
-- ─────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS anon_handle         TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS breakup_type        TEXT
    CHECK (breakup_type IS NULL OR breakup_type IN ('A','B','C','D')),
  ADD COLUMN IF NOT EXISTS days_since_breakup  INTEGER,
  ADD COLUMN IF NOT EXISTS diagnosis_summary   TEXT,
  ADD COLUMN IF NOT EXISTS situation_memo      TEXT,
  ADD COLUMN IF NOT EXISTS last_diagnosis_at   TIMESTAMPTZ;

-- ─────────────────────────────────────────
-- 2) 익명 핸들 생성 함수 (충돌 시 재시도)
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_anon_handle()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  candidate TEXT;
  attempts  INTEGER := 0;
BEGIN
  LOOP
    -- 6자 16진수 → 약 1,670만 조합. profiles.anon_handle UNIQUE 제약과 결합.
    candidate := '익명-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.profiles WHERE anon_handle = candidate
    );

    attempts := attempts + 1;
    IF attempts > 5 THEN
      -- fail-safe: 충돌 가능성이 거의 0인 8자로 확장
      candidate := '익명-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
      EXIT;
    END IF;
  END LOOP;
  RETURN candidate;
END;
$$;

-- ─────────────────────────────────────────
-- 3) 가입 트리거 — anon_handle 자동 부여
--    (기존 handle_new_user 를 덮어쓰기)
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.profiles (id, anon_handle)
  VALUES (NEW.id, public.generate_anon_handle())
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 기존 사용자(트리거 이전 가입자) anon_handle 백필
UPDATE public.profiles
SET anon_handle = public.generate_anon_handle()
WHERE anon_handle IS NULL;

-- ─────────────────────────────────────────
-- 4) 커뮤니티 — 게시글
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.community_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 작성자 탈퇴 시 글은 남기되 author_id 만 NULL 처리 → 익명성 유지
  author_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- 글에 직접 새겨두는 익명 핸들. profiles.anon_handle 변경/탈퇴와 무관하게 보존.
  anon_handle     TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('story','forum')),
  title           TEXT NOT NULL CHECK (char_length(title)   BETWEEN 1 AND 100),
  content         TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 5000),
  tag             TEXT,                                        -- 예: "고프레임/신뢰감 하락"
  likes_count     INTEGER NOT NULL DEFAULT 0,                  -- 트리거로 동기화
  comments_count  INTEGER NOT NULL DEFAULT 0,                  -- 트리거로 동기화
  is_hidden       BOOLEAN NOT NULL DEFAULT FALSE,              -- soft-delete / 모더레이션
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS community_posts_category_created_idx
  ON public.community_posts (category, created_at DESC)
  WHERE is_hidden = FALSE;

-- ─────────────────────────────────────────
-- 5) 커뮤니티 — 댓글
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.community_comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id      UUID NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
  author_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  anon_handle  TEXT NOT NULL,
  content      TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
  -- AI 모더레이터(Phase 3) 자동 댓글 식별. 클라이언트는 항상 FALSE 로만 INSERT.
  is_ai        BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS community_comments_post_idx
  ON public.community_comments (post_id, created_at);

-- ─────────────────────────────────────────
-- 6) 커뮤니티 — 좋아요 (1인 1회)
--    토글은 클라이언트가 INSERT / DELETE 로 처리.
--    PRIMARY KEY (user_id, post_id) 가 중복 방지를 자연스럽게 보장.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.community_likes (
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id     UUID NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

-- ─────────────────────────────────────────
-- 7) 카운터 동기화 트리거 (likes_count, comments_count)
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sync_post_likes_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.community_posts
    SET likes_count = likes_count + 1
    WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.community_posts
    SET likes_count = GREATEST(0, likes_count - 1)
    WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_post_likes ON public.community_likes;
CREATE TRIGGER trg_sync_post_likes
  AFTER INSERT OR DELETE ON public.community_likes
  FOR EACH ROW EXECUTE FUNCTION public.sync_post_likes_count();

CREATE OR REPLACE FUNCTION public.sync_post_comments_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.community_posts
    SET comments_count = comments_count + 1
    WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.community_posts
    SET comments_count = GREATEST(0, comments_count - 1)
    WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_post_comments ON public.community_comments;
CREATE TRIGGER trg_sync_post_comments
  AFTER INSERT OR DELETE ON public.community_comments
  FOR EACH ROW EXECUTE FUNCTION public.sync_post_comments_count();

-- ─────────────────────────────────────────
-- 8) updated_at 자동 갱신 (게시글 수정 시)
-- ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_posts_updated_at ON public.community_posts;
CREATE TRIGGER trg_posts_updated_at
  BEFORE UPDATE ON public.community_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────
-- 9) RLS — Row Level Security
-- ─────────────────────────────────────────
ALTER TABLE public.community_posts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_likes    ENABLE ROW LEVEL SECURITY;

-- 9-1) community_posts
DROP POLICY IF EXISTS "posts_public_read"  ON public.community_posts;
DROP POLICY IF EXISTS "posts_insert_self"  ON public.community_posts;
DROP POLICY IF EXISTS "posts_update_self"  ON public.community_posts;
DROP POLICY IF EXISTS "posts_delete_self"  ON public.community_posts;

-- 읽기: 숨겨지지 않은 글은 누구나 (비로그인 포함)
CREATE POLICY "posts_public_read"
  ON public.community_posts
  FOR SELECT
  USING (is_hidden = FALSE);

-- 쓰기: 로그인 사용자만, 자기 author_id 로만
CREATE POLICY "posts_insert_self"
  ON public.community_posts
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = author_id);

-- 수정: 작성자 본인만, author_id 변경 금지
CREATE POLICY "posts_update_self"
  ON public.community_posts
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

-- 삭제(soft-delete가 기본이지만 hard-delete 도 본인만 허용)
CREATE POLICY "posts_delete_self"
  ON public.community_posts
  FOR DELETE
  TO authenticated
  USING (auth.uid() = author_id);

-- 9-2) community_comments
DROP POLICY IF EXISTS "comments_public_read"  ON public.community_comments;
DROP POLICY IF EXISTS "comments_insert_self"  ON public.community_comments;
DROP POLICY IF EXISTS "comments_update_self"  ON public.community_comments;
DROP POLICY IF EXISTS "comments_delete_self"  ON public.community_comments;

CREATE POLICY "comments_public_read"
  ON public.community_comments
  FOR SELECT
  USING (is_hidden = FALSE);

-- 일반 사용자 INSERT: 반드시 본인 author_id + is_ai = FALSE
-- (AI 모더레이터 댓글은 service_role 키를 쓰는 Edge Function 에서 RLS bypass 로 처리 — Phase 3)
CREATE POLICY "comments_insert_self"
  ON public.community_comments
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = author_id AND is_ai = FALSE);

CREATE POLICY "comments_update_self"
  ON public.community_comments
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

CREATE POLICY "comments_delete_self"
  ON public.community_comments
  FOR DELETE
  TO authenticated
  USING (auth.uid() = author_id);

-- 9-3) community_likes
DROP POLICY IF EXISTS "likes_public_read"  ON public.community_likes;
DROP POLICY IF EXISTS "likes_insert_self"  ON public.community_likes;
DROP POLICY IF EXISTS "likes_delete_self"  ON public.community_likes;

-- 누가 좋아했는지 보는 화면은 없지만, "내가 눌렀나" 확인용으로 SELECT 허용.
-- (로그인 유저만 조회하도록 좁히고 싶다면 TO authenticated USING (user_id = auth.uid()) 로 교체)
CREATE POLICY "likes_public_read"
  ON public.community_likes
  FOR SELECT
  USING (TRUE);

CREATE POLICY "likes_insert_self"
  ON public.community_likes
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "likes_delete_self"
  ON public.community_likes
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ──────────────────────────────────────────────────
-- 끝.  Phase 2(AI Contextual Memory)에서는 본 마이그레이션의
-- profiles.{breakup_type, days_since_breakup, diagnosis_summary, situation_memo}
-- 컬럼을 /api/chat 엣지 라우트가 직접 읽어 시스템 프롬프트에 주입합니다.
-- ──────────────────────────────────────────────────
