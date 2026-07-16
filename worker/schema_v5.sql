-- =====================================================
-- Schema v5 — Add contest_date to messages and parsed_entries
-- Run: wrangler d1 execute ticket-db --file=schema_v5.sql --remote
-- =====================================================

-- Contest date: YYYY-MM-DD — the draw date, only when explicitly mentioned in message.
-- NULL when no date specified (most messages). Flag indicates explicit presence.
ALTER TABLE messages ADD COLUMN contest_date TEXT;
ALTER TABLE messages ADD COLUMN contest_date_explicit INTEGER DEFAULT 0;
ALTER TABLE parsed_entries ADD COLUMN contest_date TEXT;
ALTER TABLE parsed_entries ADD COLUMN contest_date_explicit INTEGER DEFAULT 0;

-- Review comment: free-text note for review workflow (add → fix → clear)
ALTER TABLE messages ADD COLUMN review_comment TEXT;

CREATE INDEX IF NOT EXISTS idx_parsed_contest_date ON parsed_entries(contest_date);
CREATE INDEX IF NOT EXISTS idx_messages_contest_date ON messages(contest_date);
