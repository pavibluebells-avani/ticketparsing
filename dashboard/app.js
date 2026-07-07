// =====================================================
// TICKET DASHBOARD — Frontend
// =====================================================

// CHANGE THIS to your Worker URL after deploying
const API_BASE = "https://ticket-api.YOUR_SUBDOMAIN.workers.dev"

let currentPage = 0
const PAGE_SIZE = 100

// =====================================================
// INIT
// =====================================================

document.addEventListener("DOMContentLoaded", () => {
    loadDashboard()
    loadGroups()
    loadMessages()

    // Auto-refresh every 30 seconds
    setInterval(() => {
        loadDashboard()
        loadMessages()
    }, 30000)
})

// =====================================================
// LOAD DASHBOARD STATS
// =====================================================

async function loadDashboard() {

    try {
        const res = await fetch(`${API_BASE}/api/dashboard`)
        const data = await res.json()

        document.getElementById("total-messages").textContent =
            data.total_messages.toLocaleString()

        document.getElementById("today-messages").textContent =
            data.today_messages.toLocaleString()

        document.getElementById("total-groups").textContent =
            data.total_groups

        // Collector status
        const badge = document.getElementById("collector-status")
        const statusText = document.getElementById("status-text")

        if (data.collector?.last_seen) {
            const ago = Math.floor((Date.now() - data.collector.last_seen) / 1000)

            if (ago < 600) { // 10 minutes
                badge.className = "status-badge online"
                statusText.textContent = "Collector Online"
            } else {
                badge.className = "status-badge offline"
                statusText.textContent = `Offline (${formatAgo(ago)})`
            }

            document.getElementById("last-seen").textContent = formatAgo(ago)
        } else {
            badge.className = "status-badge offline"
            statusText.textContent = "Never connected"
            document.getElementById("last-seen").textContent = "Never"
        }

    } catch (err) {
        console.log("Dashboard load error:", err)
    }
}

// =====================================================
// LOAD GROUPS
// =====================================================

async function loadGroups() {

    try {
        const res = await fetch(`${API_BASE}/api/groups`)
        const data = await res.json()

        const select = document.getElementById("group-filter")

        for (const group of data.groups) {
            const option = document.createElement("option")
            option.value = group.group_jid
            option.textContent = `${group.group_name || group.group_jid} (${group.message_count})`
            select.appendChild(option)
        }

    } catch (err) {
        console.log("Groups load error:", err)
    }
}

// =====================================================
// LOAD MESSAGES
// =====================================================

async function loadMessages() {

    try {
        const group = document.getElementById("group-filter").value
        const date = document.getElementById("date-filter").value

        let url = `${API_BASE}/api/messages?limit=${PAGE_SIZE}&offset=${currentPage * PAGE_SIZE}`
        if (group) url += `&group=${encodeURIComponent(group)}`
        if (date) url += `&date=${date}`

        const res = await fetch(url)
        const data = await res.json()

        const tbody = document.getElementById("messages-body")

        if (data.messages.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="empty">No messages found</td></tr>'
            return
        }

        tbody.innerHTML = data.messages.map(msg => {

            const time = msg.whatsapp_timestamp
                ? new Date(msg.whatsapp_timestamp * 1000).toLocaleString("en-IN", {
                    day: "2-digit", month: "short",
                    hour: "2-digit", minute: "2-digit",
                    hour12: true
                })
                : "—"

            const text = escapeHtml(msg.text || "")
            const sender = escapeHtml(msg.push_name || msg.sender || "Unknown")
            const group = escapeHtml(msg.group_name || msg.group_jid)

            return `<tr>
                <td>${time}</td>
                <td>${group}</td>
                <td>${sender}</td>
                <td>${text}</td>
            </tr>`

        }).join("")

        // Pagination
        document.getElementById("prev-btn").disabled = currentPage === 0
        document.getElementById("next-btn").disabled = data.messages.length < PAGE_SIZE
        document.getElementById("page-info").textContent = `Page ${currentPage + 1}`

    } catch (err) {
        console.log("Messages load error:", err)
        document.getElementById("messages-body").innerHTML =
            '<tr><td colspan="4" class="empty">Failed to load messages</td></tr>'
    }
}

// =====================================================
// PAGINATION
// =====================================================

function prevPage() {
    if (currentPage > 0) {
        currentPage--
        loadMessages()
    }
}

function nextPage() {
    currentPage++
    loadMessages()
}

// =====================================================
// HELPERS
// =====================================================

function escapeHtml(text) {
    const div = document.createElement("div")
    div.textContent = text
    return div.innerHTML
}

function formatAgo(seconds) {
    if (seconds < 60) return `${seconds}s ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    return `${Math.floor(seconds / 86400)}d ago`
}
