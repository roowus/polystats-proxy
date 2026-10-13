CREATE TABLE IF NOT EXISTS catalog (
  user_id TEXT PRIMARY KEY,
  nickname TEXT,
  saved_count INTEGER NOT NULL DEFAULT 1,
  last_seen TEXT NOT NULL
);
