// =====================================================
// POST messages to Cloudflare Worker in batches
// =====================================================

const https = require("https")
const http = require("http")

class MessagePoster {

    constructor(workerUrl, apiKey) {

        this.workerUrl = workerUrl
        this.apiKey = apiKey
        this.queue = []
        this.batchSize = 50
        this.flushInterval = 5000 // 5 seconds

        // Start periodic flush
        this._timer = setInterval(
            () => this.flush(),
            this.flushInterval
        )
    }

    // =================================================
    // ADD MESSAGE TO QUEUE
    // =================================================

    enqueue(record) {

        this.queue.push(record)

        // Flush immediately if batch is full
        if (this.queue.length >= this.batchSize) {
            this.flush()
        }
    }

    // =================================================
    // FLUSH QUEUE TO WORKER
    // =================================================

    async flush() {

        if (this.queue.length === 0) {
            return
        }

        const batch = this.queue.splice(
            0,
            this.batchSize
        )

        try {

            const response = await this._post(batch)

            if (response.ok) {

                console.log(
                    `[POST] Sent ${batch.length} messages to Worker`
                )

            } else {

                console.log(
                    `[POST] Worker returned ${response.status}, re-queuing ${batch.length} messages`
                )

                // Put failed messages back at front of queue
                this.queue.unshift(...batch)
            }

        } catch (err) {

            console.log(
                `[POST] Failed to reach Worker: ${err.message}, re-queuing`
            )

            this.queue.unshift(...batch)
        }
    }

    // =================================================
    // HTTP POST
    // =================================================

    async _post(data) {

        const body = JSON.stringify(data)
        const url = new URL(this.workerUrl)

        const options = {
            hostname: url.hostname,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: url.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                "x-api-key": this.apiKey
            }
        }

        const transport = url.protocol === "https:" ? https : http

        return new Promise((resolve, reject) => {

            const req = transport.request(options, (res) => {

                let responseData = ""

                res.on("data", chunk => {
                    responseData += chunk
                })

                res.on("end", () => {
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        data: responseData
                    })
                })
            })

            req.on("error", reject)
            req.setTimeout(10000, () => {
                req.destroy(new Error("Request timeout"))
            })

            req.write(body)
            req.end()
        })
    }

    // =================================================
    // HEARTBEAT
    // =================================================

    async sendHeartbeat(status = "online") {

        try {

            const url = this.workerUrl.replace(
                "/api/messages",
                "/api/heartbeat"
            )

            const body = JSON.stringify({
                status,
                timestamp: Date.now(),
                queue_size: this.queue.length
            })

            const urlObj = new URL(url)

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
                path: urlObj.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                    "x-api-key": this.apiKey
                }
            }

            const transport = urlObj.protocol === "https:" ? https : http

            await new Promise((resolve, reject) => {

                const req = transport.request(options, (res) => {
                    res.on("data", () => {})
                    res.on("end", resolve)
                })

                req.on("error", reject)
                req.setTimeout(5000, () => {
                    req.destroy(new Error("Heartbeat timeout"))
                })

                req.write(body)
                req.end()
            })

        } catch (err) {

            console.log(
                `[HEARTBEAT] Failed: ${err.message}`
            )
        }
    }

    // =================================================
    // STOP
    // =================================================

    stop() {

        clearInterval(this._timer)
        return this.flush()
    }
}

module.exports = MessagePoster
