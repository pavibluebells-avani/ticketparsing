// =====================================================
// TICKET COLLECTOR — Baileys WhatsApp Listener
// Captures messages and POSTs to Cloudflare Worker
// =====================================================

process.setMaxListeners(20)

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require("@whiskeysockets/baileys")

const P = require("pino")
const fs = require("fs")
const path = require("path")
const yaml = require("js-yaml")
const qrcode = require("qrcode-terminal")

const MessagePoster = require("./poster")

// =====================================================
// CONFIG
// =====================================================

const AUTH_DIR = "./auth"
const CONFIG_FILE = "./config.yaml"
const GROUP_CACHE_FILE = "./group_cache.json"
const DATA_DIR = "./data"
const RAW_DIR = "./data/raw"
const STATE_DIR = "./data/state"
const SYNC_STATE_FILE = `${STATE_DIR}/sync_state.json`
const MESSAGE_INDEX_FILE = `${STATE_DIR}/message_index.json`

// =====================================================
// ENSURE DIRECTORIES
// =====================================================

function ensureDirectories() {

    const dirs = [DATA_DIR, RAW_DIR, STATE_DIR]

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }
    }

    if (!fs.existsSync(SYNC_STATE_FILE)) {
        fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify({
            last_history_sync: null,
            last_live_message: null,
            last_message_id: null,
            version: "3.0"
        }, null, 2))
    }

    if (!fs.existsSync(MESSAGE_INDEX_FILE)) {
        fs.writeFileSync(MESSAGE_INDEX_FILE, JSON.stringify({}, null, 2))
    }
}

// =====================================================
// HELPERS
// =====================================================

function loadConfig() {

    if (!fs.existsSync(CONFIG_FILE)) {
        console.log("ERROR: config.yaml not found. Copy config.yaml.example and edit.")
        process.exit(1)
    }

    try {
        const raw = fs.readFileSync(CONFIG_FILE, "utf8")
        const parsed = yaml.load(raw)
        if (!parsed.groups) parsed.groups = []
        return parsed
    } catch (err) {
        console.log("Failed to load config:", err.message)
        process.exit(1)
    }
}

function atomicJsonSave(filepath, data) {
    const tempFile = filepath + ".tmp"
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2))
    fs.renameSync(tempFile, filepath)
}

function loadGroupCache() {
    try {
        return JSON.parse(fs.readFileSync(GROUP_CACHE_FILE, "utf8"))
    } catch { return {} }
}

function saveGroupCache(cache) {
    atomicJsonSave(GROUP_CACHE_FILE, cache)
}

function loadSyncState() {
    try {
        return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, "utf8"))
    } catch { return {} }
}

function saveSyncState(state) {
    atomicJsonSave(SYNC_STATE_FILE, state)
}

function loadMessageIndex() {
    try {
        return JSON.parse(fs.readFileSync(MESSAGE_INDEX_FILE, "utf8"))
    } catch { return {} }
}

function saveMessageIndex(index) {
    atomicJsonSave(MESSAGE_INDEX_FILE, index)
}

// =====================================================
// DAILY MESSAGE FILE (local backup)
// =====================================================

function getMessageFile(whatsappTimestamp) {

    let date

    if (whatsappTimestamp) {
        let ts = whatsappTimestamp
        if (typeof ts === "object" && ts.low !== undefined) ts = ts.low
        date = new Date(Number(ts) * 1000)
    } else {
        date = new Date()
    }

    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    const day = String(date.getDate()).padStart(2, "0")

    return path.join(RAW_DIR, `${year}-${month}-${day}_messages.jsonl`)
}

function appendMessage(data) {
    const messageFile = getMessageFile(data.whatsapp_timestamp)
    fs.appendFileSync(messageFile, JSON.stringify(data) + "\n")
}

// =====================================================
// TEXT EXTRACTION
// =====================================================

function extractMessageText(msg) {

    return (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        msg.message?.buttonsResponseMessage?.selectedButtonId ||
        msg.message?.listResponseMessage?.title ||
        ""
    )
}

function normalizeTimestamp(ts) {
    if (typeof ts === "object" && ts.low !== undefined) return ts.low
    return ts
}

// =====================================================
// PROCESS MESSAGE
// =====================================================

// In-memory caches (loaded once, persisted periodically)
let _config = null
let _groupCache = null
let _messageIndex = null
let _messageIndexDirty = false

// Server-side ignore lists (polled periodically)
let _ignoreCollect = new Set()  // groups to drop entirely
let _ignoreParse = new Set()    // groups to store but skip parsing (handled server-side, collector just knows)

async function pollIgnoredGroups() {
    try {
        const config = getConfig()
        const baseUrl = config.worker_url.replace(/\/api\/messages$/, "")
        const resp = await fetch(`${baseUrl}/api/admin/ignored-groups`, {
            headers: { "x-api-key": config.api_key }
        })
        if (resp.ok) {
            const data = await resp.json()
            _ignoreCollect = new Set(data.skip_collect || [])
            _ignoreParse = new Set(data.skip_parse || [])
            if (_ignoreCollect.size || _ignoreParse.size) {
                console.log(`[IGNORE] collect: ${_ignoreCollect.size} groups, parse-only: ${_ignoreParse.size} groups`)
            }
        }
    } catch (err) {
        console.log("[IGNORE] Failed to poll ignored groups:", err.message)
    }
}

function getConfig() {
    if (!_config) _config = loadConfig()
    return _config
}

function getGroupCache() {
    if (!_groupCache) _groupCache = loadGroupCache()
    return _groupCache
}

function getMessageIndex() {
    if (!_messageIndex) _messageIndex = loadMessageIndex()
    return _messageIndex
}

// Periodic flush of message index (every 10 seconds if dirty)
setInterval(() => {
    if (_messageIndexDirty && _messageIndex) {
        saveMessageIndex(_messageIndex)
        _messageIndexDirty = false
    }
}, 10000)

// Periodic prune: keep only last 50K message IDs to cap memory
function pruneMessageIndex() {
    const idx = getMessageIndex()
    const keys = Object.keys(idx)
    if (keys.length > 50000) {
        const toRemove = keys.slice(0, keys.length - 50000)
        for (const k of toRemove) delete idx[k]
        _messageIndexDirty = true
        console.log(`Pruned message index: removed ${toRemove.length} old entries`)
    }
}

async function processMessage(sock, msg, poster, historical = false) {

    try {

        const remoteJid = msg.key?.remoteJid
        if (!remoteJid || !remoteJid.endsWith("@g.us")) return

        // Skip groups marked as ignore_collect on server
        if (_ignoreCollect.has(remoteJid)) return

        const config = getConfig()
        const groupCache = getGroupCache()
        const messageIndex = getMessageIndex()

        const messageId = msg.key?.id
        if (messageIndex[messageId]) return

        // Discover group
        if (!groupCache[remoteJid]) {
            groupCache[remoteJid] = {
                jid: remoteJid,
                discovered_at: new Date().toISOString(),
                last_seen: new Date().toISOString()
            }
            console.log(`\nNew group discovered: ${remoteJid}`)
        }

        groupCache[remoteJid].last_seen = new Date().toISOString()

        // Resolve group name
        try {
            const meta = await sock.groupMetadata(remoteJid)
            groupCache[remoteJid].name = meta.subject
        } catch {}

        saveGroupCache(groupCache)

        // Config check
        const monitored = config.groups.find(g => g.jid === remoteJid && g.enabled !== false)

        if (historical && !monitored) {
            // Auto-allow history for all groups
        } else if (!historical && !monitored) {
            return
        }

        // Extract text
        const text = extractMessageText(msg)
        const normalizedTimestamp = normalizeTimestamp(msg.messageTimestamp)

        // Build record (no raw msg — saves memory and disk)
        const record = {
            ingest_sequence: Date.now(),
            historical,
            whatsapp_timestamp: normalizedTimestamp,
            group_jid: remoteJid,
            group_name: monitored?.name || groupCache[remoteJid]?.name || "Unknown Group",
            sender: msg.key?.participant || msg.key?.remoteJid || "",
            message_id: messageId,
            push_name: msg.pushName || "",
            text
        }

        // Save locally (backup)
        appendMessage(record)

        // POST to Cloudflare Worker
        if (poster && text && text.trim() !== "") {

            poster.enqueue({
                message_id: messageId,
                whatsapp_timestamp: normalizedTimestamp,
                group_jid: remoteJid,
                group_name: record.group_name,
                sender: record.sender,
                push_name: record.push_name,
                text: text,
                historical
            })
        }

        // Update dedup index (in-memory, flushed periodically)
        messageIndex[messageId] = 1
        _messageIndexDirty = true

        // Log
        const prefix = historical ? "[HISTORY]" : "[LIVE]"
        console.log(`${prefix} [${record.group_name}] ${text}`)

    } catch (err) {
        console.log("\nMessage processing error")
        console.log(err)
    }
}

// =====================================================
// MAIN
// =====================================================

async function start() {

    ensureDirectories()

    const config = getConfig()

    // Initialize poster
    const poster = new MessagePoster(
        config.worker_url,
        config.api_key
    )

    // Poll ignored groups on startup
    await pollIgnoredGroups()

    // Heartbeat (single interval, never stacked)
    const heartbeatMs = config.heartbeat_interval || 300000
    setInterval(() => {
        poster.sendHeartbeat("online")
    }, heartbeatMs)

    // Graceful shutdown (register ONCE, outside connect loop)
    process.once("SIGINT", async () => {
        console.log("\nShutting down...")
        if (_messageIndex && _messageIndexDirty) saveMessageIndex(_messageIndex)
        await poster.stop()
        process.exit(0)
    })

    process.once("SIGTERM", async () => {
        console.log("\nStopping...")
        if (_messageIndex && _messageIndexDirty) saveMessageIndex(_messageIndex)
        await poster.stop()
        process.exit(0)
    })

    // Connection loop — creates new socket without leaking the old one
    async function connect() {

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
        const { version } = await fetchLatestBaileysVersion()

        console.log("\nUsing WA version:", version)

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: "silent" }),
            printQRInTerminal: false,
            fireInitQueries: true,
            downloadHistory: true,
            syncFullHistory: false, // only on first connect; history already synced
            browser: ["Windows", "Desktop", "10.0"]
        })

        sock.ev.on("creds.update", saveCreds)

        sock.ev.on("connection.update", async (update) => {

            const { connection, lastDisconnect, qr } = update

            if (qr) {
                console.log("\n================================")
                console.log("SCAN QR CODE")
                console.log("================================\n")
                qrcode.generate(qr, { small: true })
                console.log("\nWhatsApp > Linked Devices\n")
            }

            if (connection === "open") {
                console.log("\n================================")
                console.log("WHATSAPP CONNECTED")
                console.log("================================\n")
                console.log("History hydration started...")
                console.log("Live ingestion active...\n")
                poster.sendHeartbeat("online")
                pruneMessageIndex()
            }

            if (connection === "close") {

                const statusCode = lastDisconnect?.error?.output?.statusCode

                console.log(`\nConnection closed: ${statusCode}`)
                poster.sendHeartbeat("disconnected")

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log("Logged out from WhatsApp")
                    if (_messageIndex && _messageIndexDirty) saveMessageIndex(_messageIndex)
                    await poster.stop()
                    process.exit(1)
                }

                // Clean up old socket listeners before reconnecting
                sock.ev.removeAllListeners()

                console.log("Reconnecting in 5 seconds...")
                setTimeout(() => connect(), 5000)
            }
        })

        // History sync
        sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, syncType }) => {

            console.log("\n================================")
            console.log("HISTORY SYNC RECEIVED")
            console.log(`Chats: ${chats.length} | Messages: ${messages.length} | Type: ${syncType}`)
            console.log("================================\n")

            for (const msg of messages) {
                await processMessage(sock, msg, poster, true)
            }

            console.log("\nHistory sync completed.\n")
        })

        // Live messages
        sock.ev.on("messages.upsert", async ({ messages }) => {

            for (const msg of messages) {
                await processMessage(sock, msg, poster, false)
            }
        })

        // Group updates
        sock.ev.on("groups.update", updates => {
            console.log("\nGroup updates received")
            console.log(updates)
        })
    }

    // Start first connection
    connect()
}

// =====================================================
// START
// =====================================================

start()
