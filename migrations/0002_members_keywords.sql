-- v2: B2B 회원정보 확장 + 사용자 관심 키워드
-- 적용: npx wrangler d1 execute mik_db --remote --file=migrations/0002_members_keywords.sql
-- (ALTER TABLE ADD COLUMN은 한 번만 실행 — 이미 적용됐다면 중복 오류는 무시)

ALTER TABLE users ADD COLUMN company TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN dept_title TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN phone TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN industry TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN company_size TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN interests TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN marketing_optin INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS user_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_keywords_user ON user_keywords(user_id);
