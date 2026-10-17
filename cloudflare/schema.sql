-- D1 schema for the docs feedback API (wrangler.jsonc -> DB binding).
-- The Worker also applies this lazily on first write, so running it manually
-- is only needed if you want the table to exist before the first request.

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  helpful INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_path ON feedback (path);
