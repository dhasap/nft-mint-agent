#!/bin/bash
# UniPix Fast Mint Launcher
# Starts fast-mint.mjs as background processes, pre-warmed
# Usage: bash launch-mints.sh

SKILL_DIR="/root/nft-minting-skill"
LOG_DIR="$SKILL_DIR/logs"
mkdir -p "$LOG_DIR"

echo "=== UniPix Auto-Mint Launcher ==="
echo "Starting pre-warmed mint processes..."
echo ""

# FCFS: 2026-05-22T16:30:00Z (23:30 WIB)
echo "[1/2] Starting FCFS mint (target: 16:30 UTC)..."
cd "$SKILL_DIR" && nohup node fast-mint.mjs "2026-05-22T16:30:00Z" 1 "FCFS" \
  > "$LOG_DIR/fcfs-mint.log" 2>&1 &
FCFS_PID=$!
echo "  PID: $FCFS_PID → $LOG_DIR/fcfs-mint.log"

# Public: 2026-05-22T17:00:00Z (00:00 WIB May 23)
echo "[2/2] Starting Public mint (target: 17:00 UTC)..."
cd "$SKILL_DIR" && nohup node fast-mint.mjs "2026-05-22T17:00:00Z" 2 "PUBLIC" \
  > "$LOG_DIR/public-mint.log" 2>&1 &
PUB_PID=$!
echo "  PID: $PUB_PID → $LOG_DIR/public-mint.log"

echo ""
echo "Both mints pre-warmed and waiting."
echo "Monitor: tail -f $LOG_DIR/fcfs-mint.log"
echo "         tail -f $LOG_DIR/public-mint.log"
echo ""
echo "PIDs: FCFS=$FCFS_PID  PUBLIC=$PUB_PID"
echo "$FCFS_PID $PUB_PID" > "$SKILL_DIR/.mint-pids"
