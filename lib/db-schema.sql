-- ──────────────────────────────────────────────────
-- 재회컨설팅 앱 — Supabase 스키마 (Source of Truth)
--   · 신규 프로젝트라면 이 파일만 통째로 실행하면 됩니다.
--   · 이미 운영 중이라면 lib/migrations/ 의 날짜순 마이그레이션을 적용하세요.
-- 마지막 적용 마이그레이션: 2026-05-05_phase1.sql
-- ──────────────────────────────────────────────────

-- ════════════════════════════════════════════════
-- 1. profiles — 유저 프로필 + 진단 결과 캐시 + 익명 핸들
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.profiles (
  id                  UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  -- 기본 프로필
  nickname            TEXT,
  gender              TEXT CHECK (gender IS NULL OR gender IN ('male','female','other')),
  avatar_url          TEXT,
  -- 익명 게시판 핸들 (예: "익명-A1B2C3"). 가입 시 자동 부여.
  anon_handle         TEXT UNIQUE,
  -- 게이미피케이션
  total_points        INTEGER DEFAULT 0,
  chat_count          INTEGER DEFAULT 0,
  current_phase       INTEGER DEFAULT 1 CHECK (current_phase IN (1,2,3)),
  -- 이별/진단 (AI 컨텍스트에 1쿼리로 주입하기 위한 캐시)
  breakup_date        DATE,
  breakup_type        TEXT CHECK (breakup_type IS NULL OR breakup_type IN ('A','B','C','D')),
  days_since_breakup  INTEGER,
  diagnosis_summary   TEXT,
  situation_memo      TEXT,
  last_diagnosis_at   TIMESTAMPTZ,
  -- 메타
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ════════════════════════════════════════════════
-- 2. diagnosis_results — 진단 이력 (profiles 캐시는 항상 "최신",
--    이 테이블은 시간축 분석용 영구 보관)
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.diagnosis_results (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id             UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  breakup_type        TEXT NOT NULL CHECK (breakup_type IN ('A','B','C','D')),
  phase               INTEGER NOT NULL CHECK (phase IN (1,2,3)),
  title               TEXT,
  summary             TEXT,
  success_rate        TEXT,
  days_since_breakup  INTEGER,
  scores              JSONB,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ════════════════════════════════════════════════
-- 3. chat_history — AI 상담 메시지 (Phase 2 Contextual Memory 조회 대상)
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.chat_history (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  role        TEXT CHECK (role IN ('user','assistant')) NOT NULL,
  content     TEXT NOT NULL,
  is_error    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_history_user_created_idx
  ON public.chat_history (user_id, created_at DESC);

-- ════════════════════════════════════════════════
-- 4. user_missions — 진행 중 미션
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.user_missions (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  mission_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT CHECK (status IN ('active','completed')) DEFAULT 'active',
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  CONSTRAINT user_missions_unique UNIQUE (user_id, mission_id)
);

-- ════════════════════════════════════════════════
-- 5. mission_completions — 인증 시스템 (Sprint 3)
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.mission_completions (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  mission_id      TEXT NOT NULL,
  title           TEXT NOT NULL,
  points_earned   INTEGER NOT NULL DEFAULT 0,
  proof_url       TEXT,
  note            TEXT,
  completed_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ════════════════════════════════════════════════
-- 6. emotion_checkins — 감정 체크인 (Sprint 4 그래프)
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.emotion_checkins (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  emotion_score  INTEGER CHECK (emotion_score BETWEEN 1 AND 5),
  emotion_label  TEXT,
  note           TEXT,
  checked_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ════════════════════════════════════════════════
-- 7. community_posts / community_comments / community_likes
-- ════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.community_posts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  anon_handle     TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('story','forum')),
  title           TEXT NOT NULL CHECK (char_length(title)   BETWEEN 1 AND 100),
  content         TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 5000),
  tag             TEXT,
  likes_count     INTEGER NOT NULL DEFAULT 0,
  comments_count  INTEGER NOT NULL DEFAULT 0,
  is_hidden       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS community_posts_category_created_idx
  ON public.community_posts (category, created_at DESC)
  WHERE is_hidden = FALSE;

CREATE TABLE IF NOT EXISTS public.community_comments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id      UUID NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
  author_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  anon_handle  TEXT NOT NULL,
  content      TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
  is_ai        BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS community_comments_post_idx
  ON public.community_comments (post_id, created_at);

CREATE TABLE IF NOT EXISTS public.community_likes (
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id     UUID NOT NULL REFERENCES public.community_posts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

-- ════════════════════════════════════════════════
-- 8. 함수 / 트리거
-- ════════════════════════════════════════════════

-- 익명 핸들 생성기
CREATE OR REPLACE FUNCTION public.generate_anon_handle()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  candidate TEXT;
  attempts  INTEGER := 0;
BEGIN
  LOOP
    candidate := '익명-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE anon_handle = candidate);
    attempts := attempts + 1;
    IF attempts > 5 THEN
      candidate := '익명-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
      EXIT;
    END IF;
  END LOOP;
  RETURN candidate;
END;
$$;

-- 가입 시 profiles 자동 생성 + anon_handle 부여 + nickname 추출
-- raw_user_meta_data 우선순위: full_name → name → user_name → preferred_username → email@앞
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  extracted_nickname TEXT;
BEGIN
  extracted_nickname := COALESCE(
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'name',
    NEW.raw_user_meta_data ->> 'user_name',
    NEW.raw_user_meta_data ->> 'preferred_username',
    NEW.raw_user_meta_data ->> 'nickname',
    split_part(NEW.email, '@', 1)
  );

  IF extracted_nickname IS NOT NULL THEN
    extracted_nickname := btrim(extracted_nickname);
    IF char_length(extracted_nickname) = 0 THEN
      extracted_nickname := NULL;
    ELSIF char_length(extracted_nickname) > 20 THEN
      extracted_nickname := substring(extracted_nickname FROM 1 FOR 20);
    END IF;
  END IF;

  INSERT INTO public.profiles (id, anon_handle, nickname)
  VALUES (NEW.id, public.generate_anon_handle(), extracted_nickname)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[handle_new_user] INSERT failed for user %: % / %',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 좋아요 카운트 동기화
CREATE OR REPLACE FUNCTION public.sync_post_likes_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.community_posts SET likes_count = likes_count + 1 WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.community_posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_sync_post_likes ON public.community_likes;
CREATE TRIGGER trg_sync_post_likes
  AFTER INSERT OR DELETE ON public.community_likes
  FOR EACH ROW EXECUTE FUNCTION public.sync_post_likes_count();

-- 댓글 카운트 동기화
CREATE OR REPLACE FUNCTION public.sync_post_comments_count()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.community_posts SET comments_count = comments_count + 1 WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.community_posts SET comments_count = GREATEST(0, comments_count - 1) WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_sync_post_comments ON public.community_comments;
CREATE TRIGGER trg_sync_post_comments
  AFTER INSERT OR DELETE ON public.community_comments
  FOR EACH ROW EXECUTE FUNCTION public.sync_post_comments_count();

-- updated_at 자동 갱신
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

-- ════════════════════════════════════════════════
-- 9. RLS — Row Level Security
-- ════════════════════════════════════════════════
ALTER TABLE public.profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diagnosis_results   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_history        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_missions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mission_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emotion_checkins    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_posts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_comments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_likes     ENABLE ROW LEVEL SECURITY;

-- 본인 데이터 정책
DROP POLICY IF EXISTS "users_own_profile"     ON public.profiles;
DROP POLICY IF EXISTS "users_own_diagnosis"   ON public.diagnosis_results;
DROP POLICY IF EXISTS "users_own_chat"        ON public.chat_history;
DROP POLICY IF EXISTS "users_own_missions"    ON public.user_missions;
DROP POLICY IF EXISTS "users_own_completions" ON public.mission_completions;
DROP POLICY IF EXISTS "users_own_emotions"    ON public.emotion_checkins;

CREATE POLICY "users_own_profile"     ON public.profiles            FOR ALL TO authenticated USING (auth.uid() = id);
CREATE POLICY "users_own_diagnosis"   ON public.diagnosis_results   FOR ALL TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users_own_chat"        ON public.chat_history        FOR ALL TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users_own_missions"    ON public.user_missions       FOR ALL TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users_own_completions" ON public.mission_completions FOR ALL TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "users_own_emotions"    ON public.emotion_checkins    FOR ALL TO authenticated USING (auth.uid() = user_id);

-- 커뮤니티 — 게시글
DROP POLICY IF EXISTS "posts_public_read"  ON public.community_posts;
DROP POLICY IF EXISTS "posts_insert_self"  ON public.community_posts;
DROP POLICY IF EXISTS "posts_update_self"  ON public.community_posts;
DROP POLICY IF EXISTS "posts_delete_self"  ON public.community_posts;

CREATE POLICY "posts_public_read"
  ON public.community_posts FOR SELECT
  USING (is_hidden = FALSE);

CREATE POLICY "posts_insert_self"
  ON public.community_posts FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = author_id);

CREATE POLICY "posts_update_self"
  ON public.community_posts FOR UPDATE TO authenticated
  USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

CREATE POLICY "posts_delete_self"
  ON public.community_posts FOR DELETE TO authenticated
  USING (auth.uid() = author_id);

-- 커뮤니티 — 댓글
DROP POLICY IF EXISTS "comments_public_read"  ON public.community_comments;
DROP POLICY IF EXISTS "comments_insert_self"  ON public.community_comments;
DROP POLICY IF EXISTS "comments_update_self"  ON public.community_comments;
DROP POLICY IF EXISTS "comments_delete_self"  ON public.community_comments;

CREATE POLICY "comments_public_read"
  ON public.community_comments FOR SELECT
  USING (is_hidden = FALSE);

CREATE POLICY "comments_insert_self"
  ON public.community_comments FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = author_id AND is_ai = FALSE);

CREATE POLICY "comments_update_self"
  ON public.community_comments FOR UPDATE TO authenticated
  USING (auth.uid() = author_id)
  WITH CHECK (auth.uid() = author_id);

CREATE POLICY "comments_delete_self"
  ON public.community_comments FOR DELETE TO authenticated
  USING (auth.uid() = author_id);

-- 커뮤니티 — 좋아요
DROP POLICY IF EXISTS "likes_public_read"  ON public.community_likes;
DROP POLICY IF EXISTS "likes_insert_self"  ON public.community_likes;
DROP POLICY IF EXISTS "likes_delete_self"  ON public.community_likes;

CREATE POLICY "likes_public_read"
  ON public.community_likes FOR SELECT USING (TRUE);

CREATE POLICY "likes_insert_self"
  ON public.community_likes FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "likes_delete_self"
  ON public.community_likes FOR DELETE TO authenticated
  USING (auth.uid() = user_id);
