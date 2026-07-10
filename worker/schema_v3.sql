-- =====================================================
-- Schema v3 — Group admin config (lottery mapping + ignore modes)
-- Run: wrangler d1 execute ticket-db --file=schema_v3.sql --remote
-- =====================================================

-- Admin-configured group settings:
--   lottery_type: overrides detected lottery for all messages in this group
--   ignore_mode:
--     'none'           — normal: store + parse (default)
--     'ignore_parse'   — store message but skip parsing (no parsed_entries created)
--     'ignore_collect' — don't store the message at all (Worker drops it on arrival)
CREATE TABLE IF NOT EXISTS group_config (
    group_jid TEXT PRIMARY KEY,
    group_name TEXT,
    lottery_type TEXT CHECK(lottery_type IS NULL OR lottery_type IN ('DEAR','KERALA','GOA')),
    ignore_mode TEXT NOT NULL DEFAULT 'none' CHECK(ignore_mode IN ('none','ignore_parse','ignore_collect')),
    updated_at TEXT DEFAULT (datetime('now'))
);
