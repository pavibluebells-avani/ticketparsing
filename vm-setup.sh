#!/bin/bash
# ==============================================
# One-shot VM provisioning script
# Run on fresh Oracle Cloud / Ubuntu VM
# ==============================================

set -e

echo "=== Ticket Collector VM Setup ==="

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2
sudo npm install -g pm2

# Install Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up

# Create app directory
sudo mkdir -p /opt/ticket-collector
sudo chown $USER:$USER /opt/ticket-collector

# Clone repo (or copy files)
echo ""
echo "=== Next Steps ==="
echo "1. Copy collector/ files to /opt/ticket-collector/"
echo "   scp -r collector/* user@vm:/opt/ticket-collector/"
echo ""
echo "2. Edit config:"
echo "   nano /opt/ticket-collector/config.yaml"
echo ""
echo "3. Install dependencies:"
echo "   cd /opt/ticket-collector && npm install"
echo ""
echo "4. First run (QR scan):"
echo "   cd /opt/ticket-collector && node index.js"
echo ""
echo "5. After QR scan, start with PM2:"
echo "   cd /opt/ticket-collector && pm2 start ecosystem.config.js"
echo "   pm2 save"
echo "   pm2 startup"
echo ""
echo "6. Set up auto-update cron:"
echo "   chmod +x /opt/ticket-collector/update.sh"
echo "   crontab -e"
echo "   # Add: 0 3 * * * /opt/ticket-collector/update.sh >> /opt/ticket-collector/logs/update.log 2>&1"
echo ""
echo "7. Configure Tailscale exit node on your laptop:"
echo "   tailscale set --exit-node=<laptop-tailscale-name>"
echo ""
echo "=== Setup Complete ==="
