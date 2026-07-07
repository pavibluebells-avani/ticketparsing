// =====================================================
// TICKET API — Cloudflare Worker
// Receives messages, stores in D1, serves dashboard API
// =====================================================

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

                for (const msg of messages) {

                    try {
                        await env.DB.prepare(`
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

                    } catch (err) {
                        // Duplicate message_id — skip silently
                        if (!err.message?.includes("UNIQUE")) {
                            console.log(`Insert error: ${err.message}`)
                        }
                    }
                }

                return json({ ok: true, inserted, total: messages.length }, 200, corsHeaders)
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

                return json({
                    total_messages: totalMessages?.count || 0,
                    today_messages: todayMessages?.count || 0,
                    total_groups: groups?.count || 0,
                    collector: heartbeat
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
