// PM2 process manager configuration
module.exports = {
    apps: [{
        name: "ticket-collector",
        script: "index.js",
        cwd: __dirname,
        instances: 1,
        autorestart: true,
        watch: false,
        max_memory_restart: "300M",
        env: {
            NODE_ENV: "production"
        },
        // Restart with exponential backoff
        exp_backoff_restart_delay: 1000,
        // Log settings
        error_file: "./logs/error.log",
        out_file: "./logs/output.log",
        merge_logs: true,
        log_date_format: "YYYY-MM-DD HH:mm:ss"
    }]
}
