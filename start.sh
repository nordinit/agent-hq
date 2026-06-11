#!/bin/bash
set -e

BASE_DIR="${AGENT_HQ_REPO_DIR:-$(cd "$(dirname "$0")" && pwd)}"

echo "🚀 Starting Agent HQ..."
cd "$BASE_DIR"

# Start API
(
  cd api
  if [ ! -d node_modules ]; then
    echo "📦 Installing API dependencies..."
    npm install
  fi
  npm run dev
) &
API_PID=$!

# Start UI
(
  cd ui
  if [ ! -d node_modules ]; then
    echo "📦 Installing UI dependencies..."
    npm install
  fi
  npm run dev
) &
UI_PID=$!

echo ""
echo "✅ Agent HQ starting:"
echo "   UI:  http://localhost:3500"
echo "   API: http://localhost:3501"
echo ""
echo "Press Ctrl+C to stop both services."
echo "API PID: $API_PID | UI PID: $UI_PID"

# Wait for both
wait $API_PID $UI_PID
