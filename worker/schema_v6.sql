-- =====================================================
-- Schema v6 — Winning numbers table
-- Run: wrangler d1 execute ticket-db --file=schema_v6.sql --remote
-- =====================================================

CREATE TABLE IF NOT EXISTS winning_numbers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draw_date TEXT NOT NULL,          -- YYYY-MM-DD
    timeslot TEXT NOT NULL,           -- 1PM, 6PM, 8PM, etc.
    lottery_type TEXT NOT NULL,       -- DEAR, KERALA, GOA
    winning_number TEXT NOT NULL,     -- 5-digit winning number (EDABC)
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(draw_date, timeslot, lottery_type)
);

CREATE INDEX IF NOT EXISTS idx_winning_date ON winning_numbers(draw_date);
CREATE INDEX IF NOT EXISTS idx_winning_slot ON winning_numbers(draw_date, timeslot);
