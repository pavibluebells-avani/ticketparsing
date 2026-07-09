-- =====================================================
-- Schema v2 — parsed_entries dedup support
-- Run: wrangler d1 execute ticket-db --file=schema_v2.sql
-- =====================================================

-- Add unique constraint and index for parsed_entries dedup.
-- Ensures INSERT OR IGNORE skips true duplicates (same message,
-- same bet number, same bet type, same rate) while allowing
-- multiple distinct entries per message.
CREATE UNIQUE INDEX IF NOT EXISTS idx_parsed_msg_num ON parsed_entries(message_id, bet_number, bet_type, rate);
