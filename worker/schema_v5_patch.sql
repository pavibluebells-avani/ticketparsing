-- Schema v5 patch — only the missing columns
ALTER TABLE messages ADD COLUMN review_comment TEXT;
ALTER TABLE parsed_entries ADD COLUMN contest_date TEXT;
ALTER TABLE parsed_entries ADD COLUMN contest_date_explicit INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_parsed_contest_date ON parsed_entries(contest_date);
CREATE INDEX IF NOT EXISTS idx_messages_contest_date ON messages(contest_date);
