#!/bin/bash
# Pre-deployment checklist script

set -e

echo "🚀 Open LLM Proxy - Deployment Pre-flight Check"
echo "================================================"
echo ""

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0
WARNINGS=0

# Function to check status
check() {
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} $1"
  else
    echo -e "${RED}✗${NC} $1"
    ERRORS=$((ERRORS + 1))
  fi
}

warn() {
  echo -e "${YELLOW}⚠${NC} $1"
  WARNINGS=$((WARNINGS + 1))
}

# Check 1: Node modules installed
echo "Checking dependencies..."
[ -d "node_modules" ]
check "Node modules installed"

[ -d "dashboard/node_modules" ]
check "Dashboard node modules installed"

# Check 2: TypeScript compiles
echo ""
echo "Checking TypeScript compilation..."
npm run tsc > /dev/null 2>&1
check "TypeScript compiles without errors"

# Check 3: Dashboard built
echo ""
echo "Checking dashboard build..."
if [ -d "dashboard/dist" ] && [ "$(ls -A dashboard/dist)" ]; then
  check "Dashboard built (dashboard/dist/ exists and not empty)"
else
  warn "Dashboard not built yet (run: npm run build:dashboard)"
fi

# Check 4: Wrangler config
echo ""
echo "Checking Cloudflare configuration..."

# Check D1 database ID
if grep -q "00000000-0000-0000-0000-000000000000" wrangler.jsonc; then
  warn "D1 database ID is placeholder (update database_id in wrangler.jsonc)"
else
  check "D1 database ID configured"
fi

# Check KV namespace ID
if grep -q "00000000000000000000000000000000" wrangler.jsonc; then
  warn "KV namespace ID is placeholder (update id in wrangler.jsonc)"
else
  check "KV namespace ID configured"
fi

# Check BASE_URL
if grep -q '"BASE_URL": "http://localhost' wrangler.jsonc; then
  warn "BASE_URL is localhost (update to production URL in wrangler.jsonc)"
else
  check "BASE_URL configured for production"
fi

# Check 5: Wrangler authenticated
echo ""
echo "Checking Wrangler authentication..."
if wrangler whoami > /dev/null 2>&1; then
  check "Wrangler authenticated"
else
  warn "Not logged in to Wrangler (run: npm run cf:login)"
fi

# Check 6: Git status (optional)
echo ""
echo "Checking Git status..."
if git rev-parse --git-dir > /dev/null 2>&1; then
  if git diff-index --quiet HEAD -- 2>/dev/null; then
    check "No uncommitted changes"
  else
    warn "You have uncommitted changes (consider committing before deploy)"
  fi
else
  warn "Not a Git repository"
fi

# Summary
echo ""
echo "================================================"
if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}✗ $ERRORS error(s) found - deployment will likely fail${NC}"
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}⚠ $WARNINGS warning(s) - review before deploying${NC}"
  echo ""
  echo "To deploy anyway, run: npm run deploy:full"
  exit 0
else
  echo -e "${GREEN}✓ All checks passed - ready to deploy!${NC}"
  echo ""
  echo "Next steps:"
  echo "  1. npm run build:dashboard  # If not built yet"
  echo "  2. npm run migrate          # Apply database migrations"
  echo "  3. npm run deploy           # Deploy to Cloudflare"
  echo ""
  echo "Or run all at once: npm run release"
  exit 0
fi
