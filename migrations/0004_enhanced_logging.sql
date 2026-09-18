-- Add token usage and pricing columns to request_logs
ALTER TABLE request_logs ADD COLUMN input_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN output_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN cache_write_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN total_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN reasoning_tokens INTEGER DEFAULT 0;

-- Pricing columns (in USD)
ALTER TABLE request_logs ADD COLUMN input_cost REAL DEFAULT 0.0;
ALTER TABLE request_logs ADD COLUMN output_cost REAL DEFAULT 0.0;
ALTER TABLE request_logs ADD COLUMN cache_read_cost REAL DEFAULT 0.0;
ALTER TABLE request_logs ADD COLUMN cache_write_cost REAL DEFAULT 0.0;
ALTER TABLE request_logs ADD COLUMN total_cost REAL DEFAULT 0.0;

-- Request metadata
ALTER TABLE request_logs ADD COLUMN request_id TEXT;
ALTER TABLE request_logs ADD COLUMN conversation_id TEXT;
ALTER TABLE request_logs ADD COLUMN duration_ms INTEGER;

-- Performance metrics
ALTER TABLE request_logs ADD COLUMN first_token_ms INTEGER;
ALTER TABLE request_logs ADD COLUMN cache_hit_rate REAL DEFAULT 0.0;

-- Create index for cost queries
CREATE INDEX IF NOT EXISTS idx_request_logs_cost
ON request_logs(account_id, created_at DESC, total_cost);

CREATE INDEX IF NOT EXISTS idx_request_logs_model_status
ON request_logs(model, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_request_logs_performance
ON request_logs(account_id, first_token_ms, cache_hit_rate);
