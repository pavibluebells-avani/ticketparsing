// =====================================================
// TICKET API — Cloudflare Worker
// Receives messages, stores in D1, serves dashboard API
// =====================================================

import { parseMessage, isNoise } from './parser.js'

export default {

    async fetch(request, env) {

        const url = new URL(request.url)
        const method = request.method

        // CORS headers for dashboard
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, x-api-key",
        }

        // Preflight
        if (method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders })
        }

        try {

            // =================================================
            // POST /api/messages — receive from collector
            // =================================================

            if (url.pathname === "/api/messages" && method === "POST") {

                // Auth check
                const apiKey = request.headers.get("x-api-key")
                if (apiKey !== env.API_KEY) {
                    return json({ error: "Unauthorized" }, 401, corsHeaders)
                }

                const messages = await request.json()

                if (!Array.isArray(messages)) {
                    return json({ error: "Expected array" }, 400, corsHeaders)
                }

                let inserted = 0
                let entriesInserted = 0

                for (const msg of messages) {

                    try {
                        const insertResult = await env.DB.prepare(`
                            INSERT OR IGNORE INTO messages
                            (message_id, whatsapp_timestamp, group_jid, group_name, sender, push_name, text, historical)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        `).bind(
                            msg.message_id,
                            msg.whatsapp_timestamp,
                            msg.group_jid,
                            msg.group_name || null,
                            msg.sender || null,
                            msg.push_name || null,
                            msg.text || null,
                            msg.historical ? 1 : 0
                        ).run()

                        inserted++

                        // Parse the message and store betting entries (only if the row was
                        // actually inserted — avoids reparsing duplicates on retry)
                        if (insertResult.meta?.changes > 0 && msg.text && !isNoise(msg.text)) {
                            try {
                                const parsed = parseMessage(
                                    msg.text, msg.group_name, msg.group_jid,
                                    msg.message_id, msg.whatsapp_timestamp,
                                    msg.sender, msg.push_name
                                )
                                if (parsed.entries.length > 0) {
                                    const stmts = parsed.entries.map(entry =>
                                        env.DB.prepare(`
                                            INSERT OR IGNORE INTO parsed_entries
                                            (message_id, whatsapp_timestamp, group_jid, group_name, sender, push_name,
                                             lottery_type, timeslot, bet_number, bet_type, quantity, rate, price, raw_line)
                                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                        `).bind(
                                            msg.message_id, msg.whatsapp_timestamp, msg.group_jid, msg.group_name || null,
                                            msg.sender || null, msg.push_name || null,
                                            parsed.lottery, parsed.timeslot,
                                            entry.number, entry.betType || entry.category, entry.qty, entry.rate,
                                            (entry.rate || 0) * (entry.qty || 1), entry.rawLine
                                        )
                                    )
                                    await env.DB.batch(stmts)
                                    entriesInserted += parsed.entries.length
                                }
                            } catch (parseErr) {
                                console.log(`Parse error for ${msg.message_id}: ${parseErr.message}`)
                            }
                        }

                    } catch (err) {
                        // Duplicate message_id — skip silently
                        if (!err.message?.includes("UNIQUE")) {
                            console.log(`Insert error: ${err.message}`)
                        }
                    }
                }

                return json({ ok: true, inserted, entries_inserted: entriesInserted, total: messages.length }, 200, corsHeaders)
            }

            // =================================================
            // POST /api/heartbeat — collector health ping
            // =================================================

            if (url.pathname === "/api/heartbeat" && method === "POST") {

                const apiKey = request.headers.get("x-api-key")
                if (apiKey !== env.API_KEY) {
                    return json({ error: "Unauthorized" }, 401, corsHeaders)
                }

                const data = await request.json()

                await env.DB.prepare(`
                    UPDATE heartbeat SET status = ?, last_seen = ?, queue_size = ?, updated_at = datetime('now')
                    WHERE id = 1
                `).bind(
                    data.status || "online",
                    data.timestamp || Date.now(),
                    data.queue_size || 0
                ).run()

                return json({ ok: true }, 200, corsHeaders)
            }

            // =================================================
            // GET /api/status — collector status for dashboard
            // =================================================

            if (url.pathname === "/api/status" && method === "GET") {

                const result = await env.DB.prepare(
                    "SELECT * FROM heartbeat WHERE id = 1"
                ).first()

                const msgCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM messages"
                ).first()

                return json({
                    collector: result,
                    total_messages: msgCount?.count || 0
                }, 200, corsHeaders)
            }

            // =================================================
            // GET /api/messages — dashboard: list messages
            // =================================================

            if (url.pathname === "/api/messages" && method === "GET") {

                const group = url.searchParams.get("group") || null
                const date = url.searchParams.get("date") || null
                const limit = parseInt(url.searchParams.get("limit") || "100")
                const offset = parseInt(url.searchParams.get("offset") || "0")

                let query = "SELECT * FROM messages WHERE 1=1"
                const params = []

                if (group) {
                    query += " AND group_jid = ?"
                    params.push(group)
                }

                if (date) {
                    // Filter by date (YYYY-MM-DD)
                    const startTs = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000)
                    const endTs = startTs + 86400
                    query += " AND whatsapp_timestamp >= ? AND whatsapp_timestamp < ?"
                    params.push(startTs, endTs)
                }

                query += " ORDER BY whatsapp_timestamp DESC LIMIT ? OFFSET ?"
                params.push(limit, offset)

                const result = await env.DB.prepare(query).bind(...params).all()

                return json({
                    messages: result.results,
                    meta: { limit, offset, count: result.results.length }
                }, 200, corsHeaders)
            }

            // =================================================
            // GET /api/groups — list all groups
            // =================================================

            if (url.pathname === "/api/groups" && method === "GET") {

                const result = await env.DB.prepare(`
                    SELECT group_jid, group_name, COUNT(*) as message_count,
                           MIN(whatsapp_timestamp) as first_message,
                           MAX(whatsapp_timestamp) as last_message
                    FROM messages
                    GROUP BY group_jid
                    ORDER BY message_count DESC
                `).all()

                return json({ groups: result.results }, 200, corsHeaders)
            }

            // =================================================
            // GET /api/dashboard — summary stats
            // =================================================

            if (url.pathname === "/api/dashboard" && method === "GET") {

                const totalMessages = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM messages"
                ).first()

                const todayStart = Math.floor(
                    new Date(new Date().toISOString().split("T")[0] + "T00:00:00Z").getTime() / 1000
                )

                const todayMessages = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM messages WHERE whatsapp_timestamp >= ?"
                ).bind(todayStart).first()

                const groups = await env.DB.prepare(
                    "SELECT COUNT(DISTINCT group_jid) as count FROM messages"
                ).first()

                const heartbeat = await env.DB.prepare(
                    "SELECT * FROM heartbeat WHERE id = 1"
                ).first()

                const parsedEntries = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM parsed_entries"
                ).first()

                return json({
                    total_messages: totalMessages?.count || 0,
                    today_messages: todayMessages?.count || 0,
                    total_groups: groups?.count || 0,
                    parsed_entries: parsedEntries?.count || 0,
                    collector: heartbeat
                }, 200, corsHeaders)
            }

            // =================================================
            // GET /api/parsed — list parsed betting entries
            // =================================================

            if (url.pathname === "/api/parsed" && method === "GET") {

                const lotteryType = url.searchParams.get("lottery_type") || null
                const timeslot = url.searchParams.get("timeslot") || null
                const betType = url.searchParams.get("bet_type") || null
                const date = url.searchParams.get("date") || null
                const group = url.searchParams.get("group") || null
                const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 1000)
                const offset = parseInt(url.searchParams.get("offset") || "0")

                let query = "SELECT * FROM parsed_entries WHERE 1=1"
                const params = []

                if (lotteryType) {
                    query += " AND lottery_type = ?"
                    params.push(lotteryType)
                }
                if (timeslot) {
                    query += " AND timeslot = ?"
                    params.push(timeslot)
                }
                if (betType) {
                    query += " AND bet_type = ?"
                    params.push(betType)
                }
                if (group) {
                    query += " AND group_jid = ?"
                    params.push(group)
                }
                if (date) {
                    const startTs = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000)
                    const endTs = startTs + 86400
                    query += " AND whatsapp_timestamp >= ? AND whatsapp_timestamp < ?"
                    params.push(startTs, endTs)
                }

                // Count total matching rows (without limit/offset)
                const countQuery = query.replace("SELECT *", "SELECT COUNT(*) as count")
                const countResult = await env.DB.prepare(countQuery).bind(...params).first()

                query += " ORDER BY whatsapp_timestamp DESC LIMIT ? OFFSET ?"
                params.push(limit, offset)

                const result = await env.DB.prepare(query).bind(...params).all()

                return json({
                    entries: result.results,
                    meta: { total: countResult?.count || 0, limit, offset }
                }, 200, corsHeaders)
            }

            // =================================================
            // GET /api/parsed/summary — aggregated counts
            // =================================================

            if (url.pathname === "/api/parsed/summary" && method === "GET") {

                const [byLottery, byTimeslot, byCategory, byDate, totalEntries, totalMessagesParsed] = await Promise.all([
                    env.DB.prepare(`
                        SELECT COALESCE(lottery_type, 'UNKNOWN') as key, COUNT(*) as count
                        FROM parsed_entries GROUP BY lottery_type
                    `).all(),
                    env.DB.prepare(`
                        SELECT COALESCE(timeslot, 'UNKNOWN') as key, COUNT(*) as count
                        FROM parsed_entries GROUP BY timeslot
                    `).all(),
                    env.DB.prepare(`
                        SELECT COALESCE(bet_type, 'UNKNOWN') as key, COUNT(*) as count
                        FROM parsed_entries GROUP BY bet_type
                    `).all(),
                    env.DB.prepare(`
                        SELECT date(whatsapp_timestamp, 'unixepoch') as key, COUNT(*) as count
                        FROM parsed_entries
                        WHERE whatsapp_timestamp IS NOT NULL
                        GROUP BY key
                        ORDER BY key DESC
                        LIMIT 60
                    `).all(),
                    env.DB.prepare("SELECT COUNT(*) as count FROM parsed_entries").first(),
                    env.DB.prepare("SELECT COUNT(DISTINCT message_id) as count FROM parsed_entries").first(),
                ])

                const toMap = (rows) => {
                    const obj = {}
                    for (const row of rows.results) obj[row.key] = row.count
                    return obj
                }

                return json({
                    by_lottery: toMap(byLottery),
                    by_timeslot: toMap(byTimeslot),
                    by_category: toMap(byCategory),
                    by_date: toMap(byDate),
                    total_entries: totalEntries?.count || 0,
                    total_messages_parsed: totalMessagesParsed?.count || 0,
                }, 200, corsHeaders)
            }

            // =================================================
            // POST /api/reparse — reparse messages missing entries
            // =================================================

            if (url.pathname === "/api/reparse" && method === "POST") {

                const apiKey = request.headers.get("x-api-key")
                if (apiKey !== env.API_KEY) {
                    return json({ error: "Unauthorized" }, 401, corsHeaders)
                }

                const BATCH_SIZE = 100

                // Find messages that have no corresponding parsed_entries rows yet.
                // Note: messages that parse to zero entries (noise, or text with no
                // recognizable betting numbers) will never gain a parsed_entries row,
                // so they'll be re-evaluated (cheaply) on every /api/reparse call until
                // the whole backlog is caught up. This is intentional — it keeps the
                // schema simple (no extra "parsed_at" column needed for this pass).
                const pending = await env.DB.prepare(`
                    SELECT m.message_id, m.whatsapp_timestamp, m.group_jid, m.group_name,
                           m.sender, m.push_name, m.text
                    FROM messages m
                    LEFT JOIN parsed_entries pe ON pe.message_id = m.message_id
                    WHERE pe.message_id IS NULL AND m.text IS NOT NULL
                    LIMIT ?
                `).bind(BATCH_SIZE).all()

                let messagesParsed = 0
                let entriesInserted = 0
                let messagesSkippedNoise = 0

                for (const msg of pending.results) {

                    if (!msg.text || isNoise(msg.text)) {
                        messagesSkippedNoise++
                        continue
                    }

                    try {
                        const parsed = parseMessage(
                            msg.text, msg.group_name, msg.group_jid,
                            msg.message_id, msg.whatsapp_timestamp,
                            msg.sender, msg.push_name
                        )

                        if (parsed.entries.length > 0) {
                            const stmts = parsed.entries.map(entry =>
                                env.DB.prepare(`
                                    INSERT OR IGNORE INTO parsed_entries
                                    (message_id, whatsapp_timestamp, group_jid, group_name, sender, push_name,
                                     lottery_type, timeslot, bet_number, bet_type, quantity, rate, price, raw_line)
                                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                `).bind(
                                    msg.message_id, msg.whatsapp_timestamp, msg.group_jid, msg.group_name || null,
                                    msg.sender || null, msg.push_name || null,
                                    parsed.lottery, parsed.timeslot,
                                    entry.number, entry.betType || entry.category, entry.qty, entry.rate,
                                    (entry.rate || 0) * (entry.qty || 1), entry.rawLine
                                )
                            )
                            await env.DB.batch(stmts)
                            entriesInserted += parsed.entries.length
                        }
                        messagesParsed++
                    } catch (parseErr) {
                        console.log(`Reparse error for ${msg.message_id}: ${parseErr.message}`)
                    }
                }

                // Are there more pending messages after this batch?
                const remaining = await env.DB.prepare(`
                    SELECT COUNT(*) as count
                    FROM messages m
                    LEFT JOIN parsed_entries pe ON pe.message_id = m.message_id
                    WHERE pe.message_id IS NULL AND m.text IS NOT NULL
                `).first()

                return json({
                    ok: true,
                    batch_size: BATCH_SIZE,
                    processed: pending.results.length,
                    messages_parsed: messagesParsed,
                    messages_skipped_noise: messagesSkippedNoise,
                    entries_inserted: entriesInserted,
                    remaining: remaining?.count || 0,
                }, 200, corsHeaders)
            }

            // =================================================
            // 404
            // =================================================

            return json({ error: "Not found" }, 404, corsHeaders)

        } catch (err) {
            console.log(`Worker error: ${err.message}`)
            return json({ error: "Internal error" }, 500, corsHeaders)
        }
    }
}

// =====================================================
// HELPER
// =====================================================

function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
            ...extraHeaders
        }
    })
}
