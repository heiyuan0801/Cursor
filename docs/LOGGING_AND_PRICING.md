# Request Logging and Pricing Analytics

This document describes the enhanced request logging system with token usage tracking and cost calculation.

## Overview

The system now tracks detailed token usage and calculates costs for each API request based on the model pricing data from [Wei-Shaw/model-price-repo](https://github.com/Wei-Shaw/model-price-repo).

## Features

### Token Usage Tracking

Each request now logs:
- **Input tokens**: Tokens in the prompt
- **Output tokens**: Tokens in the completion
- **Cache read tokens**: Tokens served from prompt cache
- **Cache write tokens**: Tokens written to prompt cache
- **Total tokens**: Sum of all token usage
- **Reasoning tokens**: Tokens used for reasoning (if applicable)

### Cost Calculation

Costs are calculated automatically based on:
- Model-specific pricing
- Token type (input, output, cache read, cache write)
- Context window thresholds (200k/272k tokens for applicable models)

### Request Metadata

Additional metadata tracked:
- Request ID and Conversation ID
- Duration in milliseconds
- Cursor Agent ID and Run ID
- Status (running, completed, error)
- Error messages (if any)

## Where the data lives

There are two independent ledgers, and which one answers `/api/usage` depends on how the
gateway runs:

- **Worker deployment**: `request_logs` in D1, scoped to an account, read with a `cmp_` key.
- **Local sidecar (the desktop app and the control console)**: an in-process ledger in
  `sidecar/usage.ts`, persisted next to the router state (`<CURSOR_ROUTER_STATE_PATH>.usage`,
  override with `USAGE_LOG_STATE_PATH`, cap with `USAGE_LOG_LIMIT`). It is read with the
  console's admin session cookie, not with a client API key.

Both expose the same response shape, so the console renders either one.

## API Endpoints

### Get Usage Statistics

```bash
GET /api/usage?start_date=2026-01-01&end_date=2026-12-31&model=claude-sonnet-5
Authorization: Bearer cmp_YOUR_API_KEY   # worker only; the sidecar uses the console session
```

**Query Parameters:**
- `start_date` (optional): ISO 8601 date string
- `end_date` (optional): ISO 8601 date string
- `model` (optional): Filter by specific model

**Response:**
```json
{
  "totalRequests": 1500,
  "completedRequests": 1450,
  "failedRequests": 50,
  "totalTokens": 5000000,
  "inputTokens": 3000000,
  "outputTokens": 1800000,
  "cacheReadTokens": 150000,
  "cacheWriteTokens": 50000,
  "totalCost": 125.50,
  "inputCost": 60.00,
  "outputCost": 60.00,
  "cacheReadCost": 0.30,
  "cacheWriteCost": 5.20,
  "averageDurationMs": 1250.5,
  "modelBreakdown": [
    {
      "model": "claude-sonnet-5",
      "requests": 1000,
      "totalCost": 85.00,
      "totalTokens": 3500000
    },
    {
      "model": "gpt-4o",
      "requests": 500,
      "totalCost": 40.50,
      "totalTokens": 1500000
    }
  ]
}
```

### Get Request Logs

```bash
GET /api/logs?limit=100&offset=0&status=completed&model=claude-sonnet-5
Authorization: Bearer cmp_YOUR_API_KEY   # worker only; the sidecar uses the console session
```

**Query Parameters:**
- `limit` (optional, default: 100, max: 1000): Number of logs to return
- `offset` (optional, default: 0): Pagination offset
- `start_date` (optional): ISO 8601 date string
- `end_date` (optional): ISO 8601 date string
- `model` (optional): Filter by model
- `status` (optional): Filter by status (running, completed, error)

**Response:**
```json
{
  "data": [
    {
      "id": "req_abc123",
      "account_id": "acc_xyz789",
      "endpoint": "chat",
      "model": "claude-sonnet-5",
      "status": "completed",
      "prompt_chars": 5000,
      "completion_chars": 2000,
      "input_tokens": 1250,
      "output_tokens": 500,
      "cache_read_tokens": 100,
      "cache_write_tokens": 50,
      "total_tokens": 1900,
      "reasoning_tokens": 0,
      "input_cost": 0.0025,
      "output_cost": 0.005,
      "cache_read_cost": 0.00002,
      "cache_write_cost": 0.000125,
      "total_cost": 0.007645,
      "duration_ms": 1250,
      "created_at": "2026-09-18T10:30:00.000Z",
      "completed_at": "2026-09-18T10:30:01.250Z",
      "request_id": "chatcmpl_abc123",
      "conversation_id": "conv_xyz789"
    }
  ]
}
```

## Supported Models

The pricing system includes support for:

### Claude Models
- claude-opus-5
- claude-sonnet-5
- claude-sonnet-4
- claude-haiku-4
- claude-mythos-5
- claude-fable-5

### GPT Models
- gpt-4o, gpt-4o-mini
- gpt-5.4-mini, gpt-5.4-nano
- gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna

### Gemini Models
- gemini-2.0-flash
- gemini-2.5-pro
- gemini-3-pro-preview

### Other Models
- DeepSeek (deepseek-chat, deepseek-reasoner)
- Grok (grok-4.3, grok-4.5, grok-4.6)
- o1, o1-mini, o3-mini

## Database Schema

The enhanced `request_logs` table includes:

```sql
ALTER TABLE request_logs ADD COLUMN input_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN output_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN cache_read_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN cache_write_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN total_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN reasoning_tokens INTEGER DEFAULT 0;
ALTER TABLE request_logs ADD COLUMN input_cost REAL DEFAULT 0.0;
ALTER TABLE request_logs ADD COLUMN output_cost REAL DEFAULT 0.0;
ALTER TABLE request_logs ADD COLUMN cache_read_cost REAL DEFAULT 0.0;
ALTER TABLE request_logs ADD COLUMN cache_write_cost REAL DEFAULT 0.0;
ALTER TABLE request_logs ADD COLUMN total_cost REAL DEFAULT 0.0;
ALTER TABLE request_logs ADD COLUMN request_id TEXT;
ALTER TABLE request_logs ADD COLUMN conversation_id TEXT;
ALTER TABLE request_logs ADD COLUMN duration_ms INTEGER;
```

## Migration

To enable the enhanced logging features:

1. Run the migration:
```bash
wrangler d1 execute <DATABASE_NAME> --file=./migrations/0004_enhanced_logging.sql
```

2. Deploy the updated worker:
```bash
npm run deploy
```

## Cost Estimation

When token usage is not available (e.g., for legacy requests), costs are estimated using:
- Character-to-token ratio: ~4 characters per token
- Model-specific pricing for estimated tokens

## Context Window Thresholds

Some models have tiered pricing based on context size:

- **GPT-5 models**: 272k token threshold
- **Grok models**: 200k token threshold
- **Gemini models**: 200k token threshold

When input exceeds these thresholds, higher pricing applies to tokens above the threshold.

## Notes

- All costs are in USD
- Pricing data is updated from the upstream repository
- Token usage is only available when the Cursor backend reports it
- Duration includes network latency and processing time
- Cache costs apply when prompt caching is used
