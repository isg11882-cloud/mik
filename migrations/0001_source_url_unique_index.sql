-- MIK D1 Migration 0001
-- source_url 컬럼에 UNIQUE 인덱스 추가
-- 실행: npx wrangler d1 execute mik_db --remote --file migrations/0001_source_url_unique_index.sql
--
-- ⚠️  주의: 이미 인덱스가 존재하면 무시됨 (IF NOT EXISTS)
--           중복 source_url이 DB에 있으면 이 SQL이 실패할 수 있음
--           그 경우 먼저 중복 행을 제거 후 재실행

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_source_url
  ON articles (source_url);
