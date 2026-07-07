# Ticket Parsing

WhatsApp message capture and lottery betting data extraction pipeline.

## Architecture

```
┌──────────────────────────┐
│  Oracle VM (free tier)   │
│  Node.js + Baileys       │
│  ├── Captures WhatsApp   │
│  ├── POST to Worker      │
│  └── PM2 keeps alive     │
└──────────┬───────────────┘
           │ Tailscale tunnel
┌──────────▼───────────────┐
│  Laptop (residential IP) │
│  Tailscale client only   │
└──────────┬───────────────┘
           │
┌──────────▼───────────────┐
│  Cloudflare              │
│  ├── Worker (API)        │
│  ├── D1 (SQLite DB)      │
│  └── Pages (Dashboard)   │
└──────────────────────────┘
```

## Project Structure

```
ticketparsing/
├── collector/          Baileys WhatsApp listener (runs on VM)
├── worker/             Cloudflare Worker API + D1 database
├── dashboard/          Cloudflare Pages frontend
├── tools/              Python parser + batch processing
└── data/               Sample JSONL data
```

## Quick Start

### 1. Deploy Cloudflare (Worker + D1 + Pages)

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create ticket-db
# Copy database_id to wrangler.toml
npm run db:init
npx wrangler secret put API_KEY
npx wrangler deploy

cd ..
npx wrangler pages project create ticket-dashboard
npx wrangler pages deploy dashboard/
```

### 2. Set Up VM (Oracle Cloud)

```bash
# On VM
bash vm-setup.sh
# Copy collector/ to /opt/ticket-collector/
cd /opt/ticket-collector
npm install
# Edit config.yaml with Worker URL and API key
node index.js          # First run — scan QR
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

### 3. Configure Tailscale

```bash
# VM
sudo tailscale up

# Laptop
tailscale up --advertise-exit-node

# VM — route traffic through laptop
tailscale set --exit-node=<laptop-name>
```

### 4. Auto-Update Cron (VM)

```bash
chmod +x /opt/ticket-collector/update.sh
crontab -e
# Add: 0 3 * * * /opt/ticket-collector/update.sh >> /opt/ticket-collector/logs/update.log 2>&1
```

## Components

### Collector (`collector/`)
- Baileys-based WhatsApp listener with history hydration
- Batched POST to Cloudflare Worker with retry queue
- Heartbeat ping every 5 minutes
- Local JSONL backup of all messages
- PM2 managed with auto-restart

### Worker (`worker/`)
- Receives messages via authenticated POST
- Stores in D1 (SQLite) database
- Serves REST API for dashboard
- Endpoints: `/api/messages`, `/api/groups`, `/api/dashboard`, `/api/status`

### Dashboard (`dashboard/`)
- Real-time message viewer with group/date filters
- Collector online/offline status
- Stats: total messages, today's count, active groups
- Bet Generator tool for composing WhatsApp messages

### Tools (`tools/`)
- `lottery_parser_v5.py` — batch parser for JSONL files
- Outputs Excel reports with dashboard, parsed entries, and parse audit

## Configuration

### collector/config.yaml
```yaml
worker_url: "https://ticket-api.example.workers.dev/api/messages"
api_key: "your-secure-key"
heartbeat_interval: 300000

groups:
  - name: "Group Name"
    jid: "group-id@g.us"
    enabled: true
```

### Worker API Key
```bash
npx wrangler secret put API_KEY
```

## Costs

| Component | Cost |
|-----------|------|
| Oracle VM (ARM, 4 CPU, 24GB) | Free forever |
| Cloudflare Workers | Free (100K req/day) |
| Cloudflare D1 | Free (5M rows read/day) |
| Cloudflare Pages | Free |
| Tailscale | Free (personal, 100 devices) |
| **Total** | **$0/month** |
