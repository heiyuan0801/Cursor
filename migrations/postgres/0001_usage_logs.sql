CREATE TABLE IF NOT EXISTS cursor_usage_logs (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'error')),
  total_tokens BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  total_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  input_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  output_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  cache_read_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  cache_write_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_cursor_usage_logs_created_at
  ON cursor_usage_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cursor_usage_logs_model_created_at
  ON cursor_usage_logs (model, created_at DESC);
