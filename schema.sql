-- MIK (MICE Insight Korea) — D1 Database Schema
-- Cloudflare D1 (SQLite-based)

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE NOT NULL,              -- RSS item guid or link (dedup key)
  title TEXT NOT NULL,
  title_ko TEXT DEFAULT '',
  link TEXT NOT NULL,
  pub_date TEXT,                           -- ISO 8601 string
  source TEXT NOT NULL,                    -- e.g. 'Skift Meetings', 'Event Industry News'
  category TEXT DEFAULT 'general',         -- exhibition, convention, incentive, tech, policy, bio
  cat_class TEXT DEFAULT 'tag-convention', -- CSS class for frontend tag
  article_type TEXT DEFAULT '분석',         -- 속보, 분석, 리포트
  author TEXT DEFAULT '',
  summary_json TEXT DEFAULT '[]',          -- JSON array of 3 summary bullet points (Korean)
  insight TEXT DEFAULT '',                 -- Korean MICE industry insight
  content_en TEXT DEFAULT '',              -- Original English article body
  content_ko TEXT DEFAULT '',              -- AI-translated Korean article body
  views INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster queries
CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
CREATE INDEX IF NOT EXISTS idx_articles_pub_date ON articles(pub_date DESC);
CREATE INDEX IF NOT EXISTS idx_articles_created_at ON articles(created_at DESC);

-- ──────────────────────────────────────────────
-- User authentication (was missing from original)
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,          -- NOTE: store hashed password in production
  name TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS user_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dark_mode INTEGER DEFAULT 0,
  notify_time_start TEXT DEFAULT '09:00',
  notify_time_end TEXT DEFAULT '21:00',
  save_news_alert TEXT DEFAULT 'all',
  partnership_alert INTEGER DEFAULT 0,
  report_alert INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id);
