#!/bin/sh
# Run Topoforge locally on macOS or Linux: ./start.sh  (opens http://localhost:8080 in your browser)
# Use another port with: PORT=8081 ./start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required: https://nodejs.org"
  exit 1
fi
exec node serve.js
