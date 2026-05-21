-- ════════════════════════════════════════════════
-- 2026-05-21_profiles_trigger_fix.sql
-- ────────────────────────────────────────────────
-- auth.users 가입 시 public.profiles 자동 생성 실패 이슈 해결
-- 1. generate_anon_handle 함수에 SECURITY DEFINER 및 search_path 설정 추가하여 권한 에러 방지
-- 2. handle_new_user 트리거 함수 내에서 구글 로그인 시 avatar_url 추출 및 ON CONFLICT DO UPDATE 구문 보강
-- ════════════════════════════════════════════════

-- 1. 익명 핸들 생성기 함수 보완 (SECURITY DEFINER / search_path 설정)
CREATE OR REPLACE FUNCTION public.generate_anon_handle()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  candidate TEXT;
  attempts  INTEGER := 0;
BEGIN
  LOOP
    -- 6자리 익명 코드 생성 (예: 익명-A1B2C3)
    candidate := '익명-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    
    -- 중복 여부 확인
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.profiles WHERE anon_handle = candidate);
    
    attempts := attempts + 1;
    -- 중복 시 최대 5회 재시도 후 실패 시 8자리로 확장하여 안전성 확보
    IF attempts > 5 THEN
      candidate := '익명-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
      EXIT;
    END IF;
  END LOOP;
  RETURN candidate;
END;
$$;

-- 2. 신규 유저 트리거 함수 고도화 (구글 avatar_url 및 ON CONFLICT 안전 장치 추가)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  extracted_nickname TEXT;
  extracted_avatar_url TEXT;
BEGIN
  -- 닉네임 추출 순위
  extracted_nickname := COALESCE(
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'name',
    NEW.raw_user_meta_data ->> 'user_name',
    NEW.raw_user_meta_data ->> 'preferred_username',
    NEW.raw_user_meta_data ->> 'nickname',
    split_part(NEW.email, '@', 1)
  );

  -- 구글 OAuth 로그인 프로필 이미지 추출
  extracted_avatar_url := COALESCE(
    NEW.raw_user_meta_data ->> 'avatar_url',
    NEW.raw_user_meta_data ->> 'picture'
  );

  -- 닉네임 값 정제 및 글자 수 제한
  IF extracted_nickname IS NOT NULL THEN
    extracted_nickname := btrim(extracted_nickname);
    IF char_length(extracted_nickname) = 0 THEN
      extracted_nickname := NULL;
    ELSIF char_length(extracted_nickname) > 20 THEN
      extracted_nickname := substring(extracted_nickname FROM 1 FOR 20);
    END IF;
  END IF;

  -- profiles 테이블에 INSERT (충돌 시 기존 레코드에 닉네임/아바타 보강)
  INSERT INTO public.profiles (id, anon_handle, nickname, avatar_url)
  VALUES (
    NEW.id, 
    public.generate_anon_handle(), 
    extracted_nickname, 
    extracted_avatar_url
  )
  ON CONFLICT (id) DO UPDATE
  SET 
    nickname = COALESCE(public.profiles.nickname, EXCLUDED.nickname),
    avatar_url = COALESCE(public.profiles.avatar_url, EXCLUDED.avatar_url),
    updated_at = NOW();

  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  -- PostgreSQL 상세 에러 로그 기록
  RAISE WARNING '[handle_new_user] INSERT failed for user %: % / %',
    NEW.id, SQLSTATE, SQLERRM;
  RETURN NEW;
END;
$$;

-- 3. 트리거 재생성
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
