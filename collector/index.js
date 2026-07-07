// =====================================================
// TICKET COLLECTOR — Baileys WhatsApp Listener
// Captures messages and POSTs to Cloudflare Worker
// =====================================================

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

async function processMessage(sock, msg, poster, historical = false) {

    try {

        const remoteJid = msg.key?.remoteJid
        if (!remoteJid || !remoteJid.endsWith("@g.us")) return

        const config = loadConfig()
        const groupCache = loadGroupCache()
        const messageIndex = loadMessageIndex()

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

        // Build record
        const record = {
            ingest_sequence: Date.now(),
            historical,
            whatsapp_timestamp: normalizedTimestamp,
            group_jid: remoteJid,
            group_name: monitored?.name || groupCache[remoteJid]?.name || "Unknown Group",
            sender: msg.key?.participant || msg.key?.remoteJid || "",
            message_id: messageId,
            push_name: msg.pushName || "",
            text,
            raw: msg
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

        // Update dedup index
        messageIndex[messageId] = true
        saveMessageIndex(messageIndex)

        // Update sync state
        const syncState = loadSyncState()
        syncState.last_live_message = Date.now()
        syncState.last_message_id = messageId
        syncState.last_whatsapp_timestamp = normalizedTimestamp
        if (historical) syncState.last_history_sync = Date.now()
        saveSyncState(syncState)

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

    const config = loadConfig()

    // Initialize poster
    const poster = new MessagePoster(
        config.worker_url,
        config.api_key
    )

    // Heartbeat
    const heartbeatMs = config.heartbeat_interval || 300000
    setInterval(() => {
        poster.sendHeartbeat("online")
    }, heartbeatMs)

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
        syncFullHistory: true,
        browser: ["Windows", "Desktop", "10.0"]
    })

    // Save creds
    sock.ev.on("creds.update", saveCreds)

    // Connection events
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
        }

        if (connection === "close") {

            const statusCode = lastDisconnect?.error?.output?.statusCode

            console.log(`\nConnection closed: ${statusCode}`)
            poster.sendHeartbeat("disconnected")

            if (statusCode === DisconnectReason.loggedOut) {
                console.log("Logged out from WhatsApp")
                await poster.stop()
                process.exit(1)
            }

            console.log("Reconnecting in 5 seconds...")
            setTimeout(() => start(), 5000)
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

    // Graceful shutdown
    process.on("SIGINT", async () => {
        console.log("\nShutting down...")
        await poster.stop()
        process.exit(0)
    })

    process.on("SIGTERM", async () => {
        console.log("\nStopping...")
        await poster.stop()
        process.exit(0)
    })
}

// =====================================================
// START
// =====================================================

start()
