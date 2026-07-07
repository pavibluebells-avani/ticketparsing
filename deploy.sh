#!/bin/bash
# ==============================================
# Deploy Worker + Dashboard to Cloudflare
# Requires: npm install -g wrangler
# First time: npx wrangler login
# ==============================================

set -e

echo "=== Deploying Ticket API ==="

# Deploy Worker
cd worker
npm install
npm run db:init 2>/dev/null || echo "DB already initialized"
npm run deploy
cd ..

echo ""
echo "=== Deploying Dashboard ==="

# Deploy Pages
# Option A: Wrangler Pages
npx wrangler pages deploy dashboard/ --project-name=ticket-dashboard

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Worker:    https://ticket-api.YOUR_SUBDOMAIN.workers.dev"
echo "Dashboard: https://ticket-dashboard.pages.dev"
echo ""
echo "Don't forget to set the API_KEY secret:"
echo "  npx wrangler secret put API_KEY"
