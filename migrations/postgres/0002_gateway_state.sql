BEGIN;
SELECT pg_advisory_xact_lock(67180919);
CREATE TABLE IF NOT EXISTS gateway_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS gateway_client_keys (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, hint TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gateway_credentials (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, hint TEXT NOT NULL, secret JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), disabled_reason TEXT
);
CREATE TABLE IF NOT EXISTS gateway_disabled_models (
  credential_id TEXT NOT NULL REFERENCES gateway_credentials(id) ON DELETE CASCADE,
  model TEXT NOT NULL, PRIMARY KEY(credential_id, model)
);
CREATE TABLE IF NOT EXISTS gateway_imports (source TEXT PRIMARY KEY, imported_at TIMESTAMPTZ NOT NULL DEFAULT now());
COMMIT;
