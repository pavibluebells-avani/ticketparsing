-- =====================================================
-- Schema v4 — Add token_trace to messages
-- Run: wrangler d1 execute ticket-db --file=schema_v4.sql --remote
-- =====================================================

-- Token trace: JSON array of {v: original_text, t: TOKEN_TYPE}
-- Produced by Python parser, consumed by dashboard for token highlighting.
-- Single source of truth — replaces JS tokenizer classification.
ALTER TABLE messages ADD COLUMN token_trace TEXT;
