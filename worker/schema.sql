-- =====================================================
-- D1 Schema for ticket-parsing
-- Run: npm run db:init
-- =====================================================

-- Raw messages from WhatsApp
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT UNIQUE NOT NULL,
    whatsapp_timestamp INTEGER,
    group_jid TEXT NOT NULL,
    group_name TEXT,
    sender TEXT,
    push_name TEXT,
    text TEXT,
    historical INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),

    -- Indexes
    UNIQUE(message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(whatsapp_timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_jid);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- Parsed betting entries (populated by parser)
CREATE TABLE IF NOT EXISTS parsed_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    whatsapp_timestamp INTEGER,
    group_jid TEXT,
    group_name TEXT,
    sender TEXT,
    push_name TEXT,
    lottery_type TEXT,
    timeslot TEXT,
    bet_number TEXT,
    bet_type TEXT,
    quantity INTEGER DEFAULT 1,
    rate INTEGER,
    price REAL,
    raw_line TEXT,
    created_at TEXT DEFAULT (datetime('now')),

    FOREIGN KEY (message_id) REFERENCES messages(message_id)
);

CREATE INDEX IF NOT EXISTS idx_parsed_timestamp ON parsed_entries(whatsapp_timestamp);
CREATE INDEX IF NOT EXISTS idx_parsed_group ON parsed_entries(group_jid);
CREATE INDEX IF NOT EXISTS idx_parsed_lottery ON parsed_entries(lottery_type);
CREATE INDEX IF NOT EXISTS idx_parsed_bettype ON parsed_entries(bet_type);

-- Collector heartbeat status
CREATE TABLE IF NOT EXISTS heartbeat (
    id INTEGER PRIMARY KEY DEFAULT 1,
    status TEXT DEFAULT 'unknown',
    last_seen INTEGER,
    queue_size INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO heartbeat (id, status) VALUES (1, 'unknown');
