-- ════════════════════════════════════════════════
-- Phase 2 마이그레이션 — 닉네임 자동 추출 + 백필
-- 적용일: 2026-05-05
--
-- 1) handle_new_user 함수를 확장: raw_user_meta_data 에서 nickname 추출
--    우선순위: full_name → name → user_name → preferred_username → email@앞
--    (Google: full_name/name, Kakao: name/user_name, Email OTP: email@앞)
-- 2) 기존 가입 사용자 백필 — nickname 이 NULL/빈문자 인 row 모두 채움
-- ════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  extracted_nickname TEXT;
BEGIN
  -- raw_user_meta_data 에서 후보 키들을 차례로 시도
  extracted_nickname := COALESCE(
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'name',
    NEW.raw_user_meta_data ->> 'user_name',
    NEW.raw_user_meta_data ->> 'preferred_username',
    NEW.raw_user_meta_data ->> 'nickname',
    split_part(NEW.email, '@', 1)
  );

  -- 공백 제거 + 20자 이내로 제한
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

-- 트리거 자체는 이미 등록되어 있지만 안전하게 재등록
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ─────────────────────────────────────────
-- 백필 — 이미 가입된 사용자의 빈 nickname 채우기
-- ─────────────────────────────────────────
UPDATE public.profiles p
SET nickname = COALESCE(
  u.raw_user_meta_data ->> 'full_name',
  u.raw_user_meta_data ->> 'name',
  u.raw_user_meta_data ->> 'user_name',
  u.raw_user_meta_data ->> 'preferred_username',
  u.raw_user_meta_data ->> 'nickname',
  split_part(u.email, '@', 1)
)
FROM auth.users u
WHERE p.id = u.id
  AND (p.nickname IS NULL OR btrim(p.nickname) = '');

-- 길이 20자 초과한 백필값 잘라내기
UPDATE public.profiles
SET nickname = substring(nickname FROM 1 FOR 20)
WHERE nickname IS NOT NULL AND char_length(nickname) > 20;

-- ─────────────────────────────────────────
-- 검증
-- ─────────────────────────────────────────
SELECT
  p.id,
  p.nickname,
  p.anon_handle,
  u.email,
  u.raw_user_meta_data ->> 'full_name' AS meta_full_name,
  u.raw_user_meta_data ->> 'name'      AS meta_name
FROM public.profiles p
JOIN auth.users u ON u.id = p.id
ORDER BY u.created_at DESC;
