// =====================================================
// TICKET API — Cloudflare Worker
// Receives messages, stores in D1, serves dashboard API
// =====================================================

import { parseMessage, isNoise, resetGroupContext } from './parser.js'

// Helper: count which individual positions matched (for partial match display)
function countPositionMatches(betNum, target, posLabel) {
    const positions = posLabel.split("")
    const matched = []
    for (let i = 0; i < betNum.length && i < target.length; i++) {
        if (betNum[i] === target[i]) matched.push(positions[i] || i)
    }
    return matched.join("")
}

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

                // Pre-fetch group configs for ignore checks
                const groupConfigs = {}
                try {
                    const cfgRows = await env.DB.prepare(
                        "SELECT group_jid, lottery_type, ignore_mode FROM group_config"
                    ).all()
                    for (const r of (cfgRows.results || [])) {
                        groupConfigs[r.group_jid] = r
                    }
                } catch (_) { /* table may not exist yet */ }

                for (const msg of messages) {

                    // Check ignore mode
                    const groupCfg = groupConfigs[msg.group_jid]
                    const ignoreMode = groupCfg?.ignore_mode || "none"

                    // ignore_collect: drop entirely — don't store, don't parse
                    if (ignoreMode === "ignore_collect") continue

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

                        // ignore_parse: store message but skip parsing
                        if (ignoreMode === "ignore_parse") continue

                        // Parse the message and store betting entries (only if the row was
                        // actually inserted — avoids reparsing duplicates on retry)
                        if (insertResult.meta?.changes > 0 && msg.text && !isNoise(msg.text)) {
                            try {
                                const parsed = parseMessage(
                                    msg.text, msg.group_name, msg.group_jid,
                                    msg.message_id, msg.whatsapp_timestamp,
                                    msg.sender, msg.push_name
                                )
                                // Apply admin group-lottery override if configured
                                if (groupCfg?.lottery_type) {
                                    parsed.lottery = groupCfg.lottery_type
                                }

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
            // GET /api/parsed/messages — messages with server-parsed entries
            // Returns messages joined with their parsed entries, grouped by message
            // =================================================

            if (url.pathname === "/api/parsed/messages" && method === "GET") {

                const lotteryType = url.searchParams.get("lottery") || null
                const timeslot = url.searchParams.get("timeslot") || null
                const category = url.searchParams.get("category") || null
                const group = url.searchParams.get("group") || null
                const date = url.searchParams.get("date") || null
                const search = url.searchParams.get("q") || null
                const sender = url.searchParams.get("sender") || null
                const msgId = url.searchParams.get("msgid") || null
                const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 500)
                const offset = parseInt(url.searchParams.get("offset") || "0")

                // Direct message_id lookup — bypass entry filters
                if (msgId) {
                    const msg = await env.DB.prepare(
                        "SELECT * FROM messages WHERE message_id = ?"
                    ).bind(msgId).first()
                    if (!msg) {
                        return json({ messages: [], meta: { total: 0, limit, offset } }, 200, corsHeaders)
                    }
                    const entries = await env.DB.prepare(
                        "SELECT * FROM parsed_entries WHERE message_id = ? ORDER BY id"
                    ).bind(msgId).all()
                    const entryList = (entries.results || []).map(e => ({
                        number: e.bet_number, betType: e.bet_type, qty: e.quantity,
                        rate: e.rate, price: e.price, rawLine: e.raw_line,
                        lottery: e.lottery_type, timeslot: e.timeslot,
                    }))
                    return json({
                        messages: [{
                            message_id: msg.message_id,
                            whatsapp_timestamp: msg.whatsapp_timestamp,
                            group_jid: msg.group_jid,
                            group_name: msg.group_name,
                            sender: msg.sender,
                            push_name: msg.push_name,
                            text: msg.text,
                            token_trace: msg.token_trace || null,
                            contest_date: msg.contest_date || null,
                            contest_date_explicit: msg.contest_date_explicit || 0,
                            review_comment: msg.review_comment || null,
                            lottery: entryList[0]?.lottery || null,
                            timeslot: entryList[0]?.timeslot || null,
                            categories: [...new Set(entryList.map(e => e.betType).filter(Boolean))],
                            rates: [...new Set(entryList.map(e => e.rate).filter(r => r != null))],
                            entries: entryList,
                        }],
                        meta: { total: 1, limit, offset }
                    }, 200, corsHeaders)
                }

                // Special case: _UNPARSED — messages with NO parsed entries
                if (lotteryType === "_UNPARSED") {
                    let unparsedFilter = "WHERE m.text IS NOT NULL"
                    const unparsedParams = []

                    if (date) {
                        const startTs = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000)
                        const endTs = startTs + 86400
                        unparsedFilter += " AND m.whatsapp_timestamp >= ? AND m.whatsapp_timestamp < ?"
                        unparsedParams.push(startTs, endTs)
                    }
                    if (group) {
                        unparsedFilter += " AND m.group_jid = ?"
                        unparsedParams.push(group)
                    }
                    if (search) {
                        unparsedFilter += " AND m.text LIKE ?"
                        unparsedParams.push(`%${search}%`)
                    }

                    const countQ = `SELECT COUNT(*) as count FROM messages m
                        LEFT JOIN parsed_entries pe ON pe.message_id = m.message_id
                        ${unparsedFilter} AND pe.message_id IS NULL`
                    const totalResult = await env.DB.prepare(countQ).bind(...unparsedParams).first()

                    const msgsQ = `SELECT m.* FROM messages m
                        LEFT JOIN parsed_entries pe ON pe.message_id = m.message_id
                        ${unparsedFilter} AND pe.message_id IS NULL
                        ORDER BY m.whatsapp_timestamp DESC LIMIT ? OFFSET ?`
                    const msgsResult = await env.DB.prepare(msgsQ).bind(...unparsedParams, limit, offset).all()

                    const messages = (msgsResult.results || []).map(msg => ({
                        message_id: msg.message_id,
                        whatsapp_timestamp: msg.whatsapp_timestamp,
                        group_jid: msg.group_jid,
                        group_name: msg.group_name,
                        sender: msg.sender,
                        push_name: msg.push_name,
                        text: msg.text,
                        token_trace: msg.token_trace || null,
                        contest_date: msg.contest_date || null,
                        contest_date_explicit: msg.contest_date_explicit || 0,
                        review_comment: msg.review_comment || null,
                        lottery: null,
                        timeslot: null,
                        categories: [],
                        rates: [],
                        entries: [],
                    }))

                    return json({
                        messages,
                        meta: { total: totalResult?.count || 0, limit, offset }
                    }, 200, corsHeaders)
                }

                // Step 1: Find matching message_ids from parsed_entries
                let entryFilter = "WHERE 1=1"
                const entryParams = []

                if (lotteryType) {
                    entryFilter += " AND pe.lottery_type = ?"
                    entryParams.push(lotteryType)
                }
                if (timeslot) {
                    entryFilter += " AND pe.timeslot = ?"
                    entryParams.push(timeslot)
                }
                if (category) {
                    entryFilter += " AND pe.bet_type = ?"
                    entryParams.push(category)
                }
                if (group) {
                    entryFilter += " AND pe.group_jid = ?"
                    entryParams.push(group)
                }
                if (date) {
                    const startTs = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000)
                    const endTs = startTs + 86400
                    entryFilter += " AND pe.whatsapp_timestamp >= ? AND pe.whatsapp_timestamp < ?"
                    entryParams.push(startTs, endTs)
                }

                // Count distinct messages matching filters
                const countQ = `SELECT COUNT(DISTINCT pe.message_id) as count FROM parsed_entries pe ${entryFilter}`
                const totalResult = await env.DB.prepare(countQ).bind(...entryParams).first()

                // Get paginated message_ids
                const msgIdQ = `SELECT DISTINCT pe.message_id, MAX(pe.whatsapp_timestamp) as ts
                    FROM parsed_entries pe ${entryFilter}
                    GROUP BY pe.message_id
                    ORDER BY ts DESC
                    LIMIT ? OFFSET ?`
                const msgIdResult = await env.DB.prepare(msgIdQ).bind(...entryParams, limit, offset).all()

                const messageIds = msgIdResult.results.map(r => r.message_id)

                if (messageIds.length === 0) {
                    return json({
                        messages: [],
                        meta: { total: totalResult?.count || 0, limit, offset }
                    }, 200, corsHeaders)
                }

                // Step 2: Fetch full messages
                const placeholders = messageIds.map(() => '?').join(',')
                const msgsResult = await env.DB.prepare(
                    `SELECT * FROM messages WHERE message_id IN (${placeholders}) ORDER BY whatsapp_timestamp DESC`
                ).bind(...messageIds).all()

                // Step 3: Fetch all parsed entries for these messages
                const entriesResult = await env.DB.prepare(
                    `SELECT * FROM parsed_entries WHERE message_id IN (${placeholders}) ORDER BY id`
                ).bind(...messageIds).all()

                // Step 4: Group entries by message_id
                const entriesByMsg = {}
                for (const e of entriesResult.results) {
                    if (!entriesByMsg[e.message_id]) entriesByMsg[e.message_id] = []
                    entriesByMsg[e.message_id].push({
                        number: e.bet_number,
                        betType: e.bet_type,
                        qty: e.quantity,
                        rate: e.rate,
                        price: e.price,
                        rawLine: e.raw_line,
                        lottery: e.lottery_type,
                        timeslot: e.timeslot,
                    })
                }

                // Step 5: Build response — apply text search filter if needed
                let messages = msgsResult.results.map(msg => {
                    const entries = entriesByMsg[msg.message_id] || []
                    const lotteries = [...new Set(entries.map(e => e.lottery).filter(Boolean))]
                    const timeslots = [...new Set(entries.map(e => e.timeslot).filter(Boolean))]
                    const categories = [...new Set(entries.map(e => e.betType).filter(Boolean))]
                    const rates = [...new Set(entries.map(e => e.rate).filter(r => r != null))]

                    return {
                        message_id: msg.message_id,
                        whatsapp_timestamp: msg.whatsapp_timestamp,
                        group_jid: msg.group_jid,
                        group_name: msg.group_name,
                        sender: msg.sender,
                        push_name: msg.push_name,
                        text: msg.text,
                        token_trace: msg.token_trace || null,
                        contest_date: msg.contest_date || null,
                        contest_date_explicit: msg.contest_date_explicit || 0,
                        review_comment: msg.review_comment || null,
                        lottery: lotteries[0] || null,
                        timeslot: timeslots[0] || null,
                        categories,
                        rates,
                        entries,
                    }
                })

                // Text search filter (on message text)
                if (search) {
                    const q = search.toLowerCase()
                    messages = messages.filter(m => (m.text || "").toLowerCase().includes(q))
                }

                // Sender filter (on push_name or sender)
                if (sender) {
                    const s = sender.toLowerCase()
                    messages = messages.filter(m =>
                        (m.push_name || "").toLowerCase().includes(s) ||
                        (m.sender || "").toLowerCase().includes(s)
                    )
                }

                return json({
                    messages,
                    meta: { total: totalResult?.count || 0, limit, offset }
                }, 200, corsHeaders)
            }

            // =================================================
            // GET /api/admin/group-map — list all group-lottery mappings
            // =================================================

            if (url.pathname === "/api/admin/group-map" && method === "GET") {
                // Return all groups (from messages) with their mapping status
                const allGroups = await env.DB.prepare(`
                    SELECT m.group_jid, m.group_name, COUNT(*) as message_count,
                           gc.lottery_type as mapped_lottery,
                           COALESCE(gc.ignore_mode, 'none') as ignore_mode
                    FROM messages m
                    LEFT JOIN group_config gc ON gc.group_jid = m.group_jid
                    GROUP BY m.group_jid
                    ORDER BY m.group_name
                `).all()

                return json({ groups: allGroups.results || [] }, 200, corsHeaders)
            }

            // =================================================
            // POST /api/admin/group-map — set group-lottery mapping
            // =================================================

            if (url.pathname === "/api/admin/group-map" && method === "POST") {
                const apiKey = request.headers.get("x-api-key")
                if (apiKey !== env.API_KEY) {
                    return json({ error: "Unauthorized" }, 401, corsHeaders)
                }

                const body = await request.json()
                const { group_jid, lottery_type, group_name, ignore_mode } = body

                if (!group_jid) {
                    return json({ error: "group_jid required" }, 400, corsHeaders)
                }
                if (lottery_type && !["DEAR", "KERALA", "GOA"].includes(lottery_type)) {
                    return json({ error: "lottery_type must be DEAR, KERALA, or GOA" }, 400, corsHeaders)
                }
                const mode = ignore_mode || "none"
                if (!["none", "ignore_parse", "ignore_collect"].includes(mode)) {
                    return json({ error: "ignore_mode must be none, ignore_parse, or ignore_collect" }, 400, corsHeaders)
                }

                await env.DB.prepare(`
                    INSERT INTO group_config (group_jid, group_name, lottery_type, ignore_mode, updated_at)
                    VALUES (?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(group_jid) DO UPDATE SET
                        lottery_type = excluded.lottery_type,
                        group_name = excluded.group_name,
                        ignore_mode = excluded.ignore_mode,
                        updated_at = datetime('now')
                `).bind(group_jid, group_name || null, lottery_type || null, mode).run()

                return json({ ok: true, group_jid, lottery_type: lottery_type || null, ignore_mode: mode }, 200, corsHeaders)
            }

            // =================================================
            // DELETE /api/admin/group-map — remove mapping (revert to auto-detect)
            // =================================================

            if (url.pathname === "/api/admin/group-map" && method === "DELETE") {
                const apiKey = request.headers.get("x-api-key")
                if (apiKey !== env.API_KEY) {
                    return json({ error: "Unauthorized" }, 401, corsHeaders)
                }

                const body = await request.json()
                const { group_jid } = body
                if (!group_jid) {
                    return json({ error: "group_jid required" }, 400, corsHeaders)
                }

                await env.DB.prepare(
                    "DELETE FROM group_config WHERE group_jid = ?"
                ).bind(group_jid).run()

                return json({ ok: true, group_jid, lottery_type: null }, 200, corsHeaders)
            }

            // =================================================
            // POST /api/admin/remap-group — apply mapping to existing entries
            // =================================================

            if (url.pathname === "/api/admin/remap-group" && method === "POST") {
                const apiKey = request.headers.get("x-api-key")
                if (apiKey !== env.API_KEY) {
                    return json({ error: "Unauthorized" }, 401, corsHeaders)
                }

                const body = await request.json()
                const { group_jid } = body
                if (!group_jid) {
                    return json({ error: "group_jid required" }, 400, corsHeaders)
                }

                const mapping = await env.DB.prepare(
                    "SELECT lottery_type FROM group_config WHERE group_jid = ?"
                ).bind(group_jid).first()

                if (!mapping) {
                    return json({ error: "No mapping found for this group" }, 400, corsHeaders)
                }

                const result = await env.DB.prepare(
                    "UPDATE parsed_entries SET lottery_type = ? WHERE group_jid = ?"
                ).bind(mapping.lottery_type, group_jid).run()

                return json({
                    ok: true,
                    group_jid,
                    lottery_type: mapping.lottery_type,
                    updated: result.meta?.changes || 0
                }, 200, corsHeaders)
            }

            // =================================================
            // GET /api/admin/ignored-groups — list groups the collector should skip
            // Returns group_jids with ignore_collect mode (collector polls this)
            // =================================================

            if (url.pathname === "/api/admin/ignored-groups" && method === "GET") {
                try {
                    const rows = await env.DB.prepare(
                        "SELECT group_jid, ignore_mode FROM group_config WHERE ignore_mode != 'none'"
                    ).all()
                    return json({
                        skip_collect: (rows.results || []).filter(r => r.ignore_mode === "ignore_collect").map(r => r.group_jid),
                        skip_parse: (rows.results || []).filter(r => r.ignore_mode === "ignore_parse").map(r => r.group_jid),
                    }, 200, corsHeaders)
                } catch (_) {
                    return json({ skip_collect: [], skip_parse: [] }, 200, corsHeaders)
                }
            }

            // =================================================
            // GET /api/report/booking — aggregated booking report
            // =================================================

            if (url.pathname === "/api/report/booking" && method === "GET") {
                const lottery = url.searchParams.get("lottery") || null
                const timeslot = url.searchParams.get("timeslot") || null
                const date = url.searchParams.get("date") || null
                const group = url.searchParams.get("group") || null

                let where = "WHERE 1=1"
                const params = []

                if (lottery) { where += " AND lottery_type = ?"; params.push(lottery) }
                if (timeslot) { where += " AND timeslot = ?"; params.push(timeslot) }
                if (group) { where += " AND group_jid = ?"; params.push(group) }
                if (date) {
                    const startTs = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000)
                    const endTs = startTs + 86400
                    where += " AND whatsapp_timestamp >= ? AND whatsapp_timestamp < ?"
                    params.push(startTs, endTs)
                }

                const rows = await env.DB.prepare(`
                    SELECT bet_type, rate,
                           SUM(quantity) as booking,
                           SUM(price) as total,
                           COUNT(DISTINCT message_id) as msg_count
                    FROM parsed_entries
                    ${where}
                    GROUP BY bet_type, rate
                    ORDER BY rate DESC, bet_type
                `).bind(...params).all()

                // Group name for display
                let groupName = null
                if (group) {
                    const g = await env.DB.prepare(
                        "SELECT group_name FROM messages WHERE group_jid = ? LIMIT 1"
                    ).bind(group).first()
                    groupName = g?.group_name || group
                }

                return json({
                    rows: rows.results || [],
                    group_name: groupName,
                    filters: { lottery, timeslot, date, group }
                }, 200, corsHeaders)
            }

            // =================================================
            // GET /api/report/message-counts — messages per day/timeslot/group
            // =================================================

            if (url.pathname === "/api/report/message-counts" && method === "GET") {
                const date = url.searchParams.get("date") || null
                const lottery = url.searchParams.get("lottery") || null

                let where = "WHERE pe.message_id IS NOT NULL"
                const params = []

                if (lottery) { where += " AND pe.lottery_type = ?"; params.push(lottery) }
                if (date) {
                    const startTs = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000)
                    const endTs = startTs + 86400
                    where += " AND pe.whatsapp_timestamp >= ? AND pe.whatsapp_timestamp < ?"
                    params.push(startTs, endTs)
                }

                const rows = await env.DB.prepare(`
                    SELECT pe.group_jid, pe.group_name, pe.timeslot,
                           DATE(pe.whatsapp_timestamp, 'unixepoch') as day,
                           COUNT(DISTINCT pe.message_id) as msg_count,
                           SUM(pe.quantity) as total_tickets
                    FROM parsed_entries pe
                    ${where}
                    GROUP BY pe.group_jid, pe.timeslot, day
                    ORDER BY day DESC, pe.group_name, pe.timeslot
                `).bind(...params).all()

                return json({ rows: rows.results || [] }, 200, corsHeaders)
            }

            // =================================================
            // POST /api/ingest-batch — receive pre-parsed data from Python
            // Accepts: { messages: [...], entries: [...] }
            // Inserts raw messages + parsed entries into D1
            // =================================================

            if (url.pathname === "/api/ingest-batch" && method === "POST") {

                const apiKey = request.headers.get("x-api-key")
                if (apiKey !== env.API_KEY) {
                    return json({ error: "Unauthorized" }, 401, corsHeaders)
                }

                const payload = await request.json()
                const rawMessages = payload.messages || []
                const parsedEntries = payload.entries || []

                let messagesInserted = 0
                let entriesInserted = 0

                // Insert raw messages (REPLACE to update token_trace on reparse)
                if (rawMessages.length > 0) {
                    const msgStmts = rawMessages.map(msg =>
                        env.DB.prepare(`
                            INSERT INTO messages
                            (message_id, whatsapp_timestamp, group_jid, group_name, sender, push_name, text, historical, token_trace, contest_date, contest_date_explicit)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(message_id) DO UPDATE SET token_trace = excluded.token_trace, contest_date = excluded.contest_date, contest_date_explicit = excluded.contest_date_explicit
                        `).bind(
                            msg.message_id,
                            msg.whatsapp_timestamp,
                            msg.group_jid,
                            msg.group_name || null,
                            msg.sender || null,
                            msg.push_name || null,
                            msg.text || null,
                            msg.historical ? 1 : 0,
                            msg.token_trace || null,
                            msg.contest_date || null,
                            msg.contest_date_explicit || 0
                        )
                    )
                    // D1 batch limit ~100
                    for (let i = 0; i < msgStmts.length; i += 100) {
                        const results = await env.DB.batch(msgStmts.slice(i, i + 100))
                        for (const r of results) {
                            messagesInserted += (r.meta?.changes || 0)
                        }
                    }
                }

                // Insert parsed entries
                if (parsedEntries.length > 0) {
                    const entryStmts = parsedEntries.map(e =>
                        env.DB.prepare(`
                            INSERT OR IGNORE INTO parsed_entries
                            (message_id, whatsapp_timestamp, group_jid, group_name, sender, push_name,
                             lottery_type, timeslot, bet_number, bet_type, quantity, rate, price, raw_line, contest_date, contest_date_explicit)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        `).bind(
                            e.message_id, e.whatsapp_timestamp, e.group_jid, e.group_name || null,
                            e.sender || null, e.push_name || null,
                            e.lottery_type || null, e.timeslot || null,
                            e.bet_number, e.bet_type, e.quantity || 1, e.rate || 0,
                            e.price || 0, e.raw_line || null, e.contest_date || null, e.contest_date_explicit || 0
                        )
                    )
                    for (let i = 0; i < entryStmts.length; i += 100) {
                        const results = await env.DB.batch(entryStmts.slice(i, i + 100))
                        for (const r of results) {
                            entriesInserted += (r.meta?.changes || 0)
                        }
                    }
                }

                return json({
                    ok: true,
                    messages_received: rawMessages.length,
                    messages_inserted: messagesInserted,
                    entries_received: parsedEntries.length,
                    entries_inserted: entriesInserted,
                }, 200, corsHeaders)
            }

            // =================================================
            // POST /api/messages/:id/comment — save or clear review comment
            // =================================================

            const commentMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/comment$/)
            if (commentMatch && method === "POST") {

                const apiKey = request.headers.get("x-api-key")
                if (apiKey !== env.API_KEY) {
                    return json({ error: "Unauthorized" }, 401, corsHeaders)
                }

                const messageId = decodeURIComponent(commentMatch[1])
                const body = await request.json()
                const comment = body.comment || null  // null = clear

                await env.DB.prepare(
                    "UPDATE messages SET review_comment = ? WHERE message_id = ?"
                ).bind(comment, messageId).run()

                return json({ ok: true, message_id: messageId, review_comment: comment }, 200, corsHeaders)
            }

            // =================================================
            // POST /api/winning — save or update winning number
            // =================================================

            if (url.pathname === "/api/winning" && method === "POST") {
                const apiKey = request.headers.get("x-api-key")
                if (apiKey !== env.API_KEY) {
                    return json({ error: "Unauthorized" }, 401, corsHeaders)
                }

                const body = await request.json()
                const { draw_date, timeslot, lottery_type, winning_number } = body

                if (!draw_date || !timeslot || !lottery_type || !winning_number) {
                    return json({ error: "draw_date, timeslot, lottery_type, winning_number required" }, 400, corsHeaders)
                }
                if (!/^\d{5}$/.test(winning_number)) {
                    return json({ error: "winning_number must be exactly 5 digits" }, 400, corsHeaders)
                }

                await env.DB.prepare(`
                    INSERT INTO winning_numbers (draw_date, timeslot, lottery_type, winning_number, updated_at)
                    VALUES (?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(draw_date, timeslot, lottery_type)
                    DO UPDATE SET winning_number = excluded.winning_number, updated_at = datetime('now')
                `).bind(draw_date, timeslot, lottery_type, winning_number).run()

                return json({ ok: true, draw_date, timeslot, lottery_type, winning_number }, 200, corsHeaders)
            }

            // =================================================
            // GET /api/winning — fetch winning number(s)
            // =================================================

            if (url.pathname === "/api/winning" && method === "GET") {
                const draw_date = url.searchParams.get("date")
                const timeslot = url.searchParams.get("timeslot")
                const lottery_type = url.searchParams.get("lottery_type")

                let query = "SELECT * FROM winning_numbers WHERE 1=1"
                const params = []

                if (draw_date) { query += " AND draw_date = ?"; params.push(draw_date) }
                if (timeslot) { query += " AND timeslot = ?"; params.push(timeslot) }
                if (lottery_type) { query += " AND lottery_type = ?"; params.push(lottery_type) }

                query += " ORDER BY draw_date DESC, timeslot"
                const result = await env.DB.prepare(query).bind(...params).all()
                return json({ winning_numbers: result.results || [] }, 200, corsHeaders)
            }

            // =================================================
            // GET /api/winning/check — match bets against winning number
            // =================================================

            if (url.pathname === "/api/winning/check" && method === "GET") {
                const draw_date = url.searchParams.get("date")
                const timeslot = url.searchParams.get("timeslot")
                const lottery_type = url.searchParams.get("lottery_type")

                if (!draw_date || !timeslot || !lottery_type) {
                    return json({ error: "date, timeslot, lottery_type required" }, 400, corsHeaders)
                }

                // Get winning number
                const winning = await env.DB.prepare(
                    "SELECT winning_number FROM winning_numbers WHERE draw_date = ? AND timeslot = ? AND lottery_type = ?"
                ).bind(draw_date, timeslot, lottery_type).first()

                if (!winning) {
                    return json({ error: "No winning number found", winning_number: null, matches: [] }, 200, corsHeaders)
                }

                const wn = winning.winning_number // 5-digit EDABC

                // Get all bets for this date + timeslot + lottery
                const startTs = Math.floor(new Date(draw_date + "T00:00:00Z").getTime() / 1000)
                const endTs = startTs + 86400

                const bets = await env.DB.prepare(`
                    SELECT pe.*, m.push_name, m.group_name, m.text
                    FROM parsed_entries pe
                    JOIN messages m ON pe.message_id = m.message_id
                    WHERE pe.lottery_type = ?
                      AND pe.timeslot = ?
                      AND pe.whatsapp_timestamp >= ? AND pe.whatsapp_timestamp < ?
                    ORDER BY pe.whatsapp_timestamp DESC
                `).bind(lottery_type, timeslot, startTs, endTs).all()

                // Position extraction from winning number (right-aligned)
                // Winning: EDABC (index 0=E, 1=D, 2=A, 3=B, 4=C)
                const posMap = { E: wn[0], D: wn[1], A: wn[2], B: wn[3], C: wn[4] }

                const results = (bets.results || []).map(bet => {
                    const num = bet.bet_number || ""
                    const dlen = num.length
                    const betType = (bet.bet_type || "").toUpperCase()
                    let matched = false
                    let matchType = ""
                    let matchedPositions = ""

                    if (dlen === 5) {
                        // Full EDABC match
                        matched = num === wn
                        matchType = matched ? "EDABC" : ""
                        matchedPositions = matched ? "EDABC" : countPositionMatches(num, wn, "EDABC")
                    } else if (dlen === 4) {
                        // DABC — last 4 digits
                        const target = wn.slice(1) // DABC
                        matched = num === target
                        matchType = matched ? "DABC" : ""
                        matchedPositions = matched ? "DABC" : countPositionMatches(num, target, "DABC")
                    } else if (dlen === 3) {
                        // ABC — last 3 digits
                        const target = wn.slice(2) // ABC
                        matched = num === target
                        matchType = matched ? "ABC" : ""
                        matchedPositions = matched ? "ABC" : countPositionMatches(num, target, "ABC")
                    } else if (dlen === 2) {
                        // Position-dependent: AB, BC, AC
                        let target = ""
                        if (betType === "AB") { target = wn[2] + wn[3]; matchType = "AB" }
                        else if (betType === "BC") { target = wn[3] + wn[4]; matchType = "BC" }
                        else if (betType === "AC") { target = wn[2] + wn[4]; matchType = "AC" }
                        else { target = wn[2] + wn[3]; matchType = "AB" } // default AB
                        matched = num === target
                        matchedPositions = matched ? matchType : countPositionMatches(num, target, matchType)
                        if (!matched) matchType = ""
                    } else if (dlen === 1) {
                        // Position-dependent: A, B, C
                        let target = ""
                        if (betType === "A") { target = wn[2]; matchType = "A" }
                        else if (betType === "B") { target = wn[3]; matchType = "B" }
                        else if (betType === "C") { target = wn[4]; matchType = "C" }
                        else { target = wn[4]; matchType = "C" } // default C
                        matched = num === target
                        matchedPositions = matched ? matchType : ""
                        if (!matched) matchType = ""
                    }

                    return {
                        bet_number: num,
                        bet_type: bet.bet_type,
                        qty: bet.quantity,
                        rate: bet.rate,
                        price: bet.price,
                        push_name: bet.push_name,
                        group_name: bet.group_name,
                        message_id: bet.message_id,
                        matched,
                        match_type: matchType,
                        matched_positions: matchedPositions,
                    }
                })

                // Summary
                const totalBets = results.length
                const winners = results.filter(r => r.matched)
                const totalWinners = winners.length
                const totalPayout = winners.reduce((s, w) => s + (w.price || 0), 0)

                return json({
                    winning_number: wn,
                    draw_date,
                    timeslot,
                    lottery_type,
                    summary: { total_bets: totalBets, total_winners: totalWinners, total_payout: totalPayout },
                    matches: results,
                }, 200, corsHeaders)
            }

            // =================================================
            // POST /api/reparse — reparse all messages (full wipe + rebuild)
            // =================================================

            if (url.pathname === "/api/reparse" && method === "POST") {

                const apiKey = request.headers.get("x-api-key")
                if (apiKey !== env.API_KEY) {
                    return json({ error: "Unauthorized" }, 401, corsHeaders)
                }

                // Check if wipe-only mode (used by Python parser to avoid JS re-parse)
                let body = {}
                try { body = await request.json() } catch (_) {}
                const wipeOnly = body.wipe_only === true

                // Step 1: Count existing entries before wipe
                const beforeCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM parsed_entries"
                ).first()

                // Step 2: Delete ALL parsed entries
                await env.DB.prepare("DELETE FROM parsed_entries").run()

                // If wipe_only, return immediately — Python parser will re-upload
                if (wipeOnly) {
                    return json({
                        entries_deleted: beforeCount?.count || 0,
                        messages_reparsed: 0,
                        entries_inserted: 0,
                        wipe_only: true
                    }, 200, corsHeaders)
                }

                // Step 3: Reparse all messages in batches (JS parser)
                const BATCH_SIZE = 200
                let totalMessages = 0
                let totalEntries = 0
                let totalSkipped = 0
                let offset = 0
                let hasMore = true

                while (hasMore) {
                    const batch = await env.DB.prepare(`
                        SELECT m.message_id, m.whatsapp_timestamp, m.group_jid, m.group_name,
                               m.sender, m.push_name, m.text
                        FROM messages m
                        WHERE m.text IS NOT NULL
                        ORDER BY m.whatsapp_timestamp
                        LIMIT ? OFFSET ?
                    `).bind(BATCH_SIZE, offset).all()

                    if (!batch.results || batch.results.length === 0) {
                        hasMore = false
                        break
                    }

                    // Preload all group overrides for this batch
                    const groupJids = [...new Set(batch.results.map(m => m.group_jid))]
                    const overrides = {}
                    for (const jid of groupJids) {
                        try {
                            const row = await env.DB.prepare(
                                "SELECT lottery_type, ignore_mode FROM group_config WHERE group_jid = ?"
                            ).bind(jid).first()
                            if (row) overrides[jid] = row
                        } catch (_) {}
                    }

                    const insertStmts = []

                    for (const msg of batch.results) {
                        // Skip ignored groups
                        if (overrides[msg.group_jid]?.ignore_mode === 'ignore_parse') {
                            totalSkipped++
                            continue
                        }

                        if (!msg.text || isNoise(msg.text)) {
                            totalSkipped++
                            continue
                        }

                        try {
                            const parsed = parseMessage(
                                msg.text, msg.group_name, msg.group_jid,
                                msg.message_id, msg.whatsapp_timestamp,
                                msg.sender, msg.push_name
                            )

                            // Apply admin group-lottery override
                            if (overrides[msg.group_jid]?.lottery_type) {
                                parsed.lottery = overrides[msg.group_jid].lottery_type
                            }

                            if (parsed.entries.length > 0) {
                                for (const entry of parsed.entries) {
                                    insertStmts.push(
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
                                }
                                totalEntries += parsed.entries.length
                            }
                            totalMessages++
                        } catch (parseErr) {
                            console.log(`Reparse error for ${msg.message_id}: ${parseErr.message}`)
                        }
                    }

                    // Batch insert (D1 limit is ~100 stmts per batch)
                    for (let i = 0; i < insertStmts.length; i += 100) {
                        await env.DB.batch(insertStmts.slice(i, i + 100))
                    }

                    offset += BATCH_SIZE
                    if (batch.results.length < BATCH_SIZE) hasMore = false
                }

                return json({
                    ok: true,
                    entries_deleted: beforeCount?.count || 0,
                    messages_reparsed: totalMessages,
                    messages_skipped: totalSkipped,
                    entries_inserted: totalEntries,
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
