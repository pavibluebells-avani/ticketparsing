# Architecture

## System Overview

This system captures WhatsApp lottery betting messages in real-time, stores them in a cloud database, and provides a web dashboard for monitoring.

## Components

### 1. Collector (Oracle VM)

**Purpose:** Maintain a persistent WhatsApp connection and capture all group messages.

**Technology:** Node.js 20 LTS + Baileys library

**How it works:**
- Baileys opens a WebSocket connection to WhatsApp servers using the multi-device protocol
- On first connect, QR code is displayed in terminal for authentication via SSH
- Auth credentials are stored on disk — subsequent restarts reconnect without QR
- On connect, history hydration pulls recent messages from all monitored groups
- Live messages are captured via the `messages.upsert` event
- Messages are batched and POSTed to the Cloudflare Worker every 5 seconds (or when batch hits 50)
- Failed POSTs are re-queued automatically
- Local JSONL backup is written for every message (disaster recovery)
- PM2 process manager handles auto-restart on crash or VM reboot
- Heartbeat POST every 5 minutes so the dashboard knows the collector is alive

**Key files:**
- `index.js` — main Baileys connection, message processing, QR auth
- `poster.js` — batched HTTP POST to Worker with retry logic
- `config.yaml` — Worker URL, API key, monitored group JIDs
- `ecosystem.config.js` — PM2 configuration

### 2. Tailscale Tunnel

**Purpose:** Route the VM's WhatsApp traffic through a residential IP to avoid detection.

**How it works:**
- VM and laptop both join the same Tailscale network
- Laptop advertises itself as an exit node
- VM routes all traffic through the laptop's exit node
- WhatsApp sees the laptop's residential IP, not the VM's datacenter IP
- If laptop goes offline, traffic pauses; on reconnect, Baileys auto-reconnects and hydrates missed messages

**Why Tailscale over alternatives:**
- Free for personal use
- Handles NAT traversal automatically
- Auto-reconnects on network changes
- No open ports on home router needed
- Built on WireGuard (fast, secure)

### 3. Cloudflare Worker (API)

**Purpose:** Receive messages from collector, store in D1, serve API for dashboard.

**Technology:** Cloudflare Workers (V8 isolates, not Node.js)

**Endpoints:**

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/messages` | API key | Receive message batch from collector |
| POST | `/api/heartbeat` | API key | Collector health ping |
| GET | `/api/messages` | None | List messages (with group/date filters) |
| GET | `/api/groups` | None | List all groups with message counts |
| GET | `/api/dashboard` | None | Summary stats for dashboard |
| GET | `/api/status` | None | Collector online/offline status |

**Security:** POST endpoints require `x-api-key` header. The key is stored as a Cloudflare Worker secret (not in code or config files).

### 4. Cloudflare D1 (Database)

**Purpose:** Persistent storage for all messages and parsed data.

**Technology:** D1 (SQLite at the edge)

**Tables:**
- `messages` — raw WhatsApp messages (message_id, text, sender, group, timestamp)
- `parsed_entries` — parsed betting data (number, type, quantity, rate, price)
- `heartbeat` — collector status (online/offline, last seen)

**Capacity:** Free tier supports 5M row reads/day and 100K row writes/day — sufficient for 31 groups × 1500 messages/day.

### 5. Cloudflare Pages (Dashboard)

**Purpose:** Web frontend for monitoring messages and system health.

**Technology:** Static HTML/CSS/JS (no build step, no framework)

**Features:**
- Real-time message list with group and date filters
- Collector online/offline indicator with "last seen" time
- Stats cards: total messages, today's count, active groups
- Auto-refreshes every 30 seconds
- Bet Generator tool for composing standardized WhatsApp messages

### 6. Python Parser (Local Tool)

**Purpose:** Batch processing of JSONL files into structured Excel reports.

**Technology:** Python 3 + pandas + openpyxl

**What it does:**
- Reads JSONL files from `data/raw/`
- Extracts betting numbers, types, quantities, rates from conversational messages
- Outputs Excel with Dashboard, Parsed Entries, Parse Audit, Raw Messages sheets
- Parse Audit includes token-by-token breakdown with confidence coloring

**When to use:** For deep analysis, Excel reports, or processing historical data that predates the cloud pipeline.

## Data Flow

```
WhatsApp Message
    │
    ▼
Baileys (VM) captures message
    │
    ├──► Local JSONL backup (disaster recovery)
    │
    ▼
POST batch to Cloudflare Worker
    │
    ▼
Worker writes to D1
    │
    ▼
Dashboard polls Worker API
    │
    ▼
User sees message in browser (~1-5 seconds end-to-end)
```

## Auto-Update Flow

```
Daily at 3 AM (cron on VM):
    │
    ├── npm update @whiskeysockets/baileys
    │
    ├── Version changed?
    │     ├── Yes → pm2 restart (5-10s downtime, auto-hydration)
    │     └── No  → do nothing
    │
    └── Log result to /opt/ticket-collector/logs/update.log
```

## Failure Modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| Laptop sleeps | Tailscale tunnel drops, Baileys disconnects | Laptop wakes → tunnel auto-reconnects → Baileys reconnects + hydrates |
| VM restarts | Collector stops | PM2 auto-restarts, Baileys reconnects using saved auth |
| Worker down | POSTs fail | Collector re-queues messages, retries on next flush |
| WhatsApp protocol change | Baileys breaks | npm update pulls community fix, cron restarts |
| D1 quota exceeded | Writes rejected | Unlikely at current scale; upgrade to paid if needed |

## Security

- Worker POST endpoints require API key (stored as Cloudflare secret)
- Auth credentials stored only on VM disk (never in git)
- `.dev.vars` and `auth/` directories are gitignored
- Tailscale tunnel is encrypted (WireGuard)
- No open ports on home router
- Dashboard is read-only (no write endpoints exposed without auth)
