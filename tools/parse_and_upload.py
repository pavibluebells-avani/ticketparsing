"""
parse_and_upload.py — Cron job that reads local JSONL files,
parses with lottery_parser_v5, and uploads to Cloudflare D1 via Worker API.

Usage:
  python parse_and_upload.py                    # process new messages only
  python parse_and_upload.py --reparse          # wipe DB + reparse everything
  python parse_and_upload.py --date 2025-07-15  # process specific date file only

Runs from: ~/ticketparsing/tools/
Reads:     ~/ticketparsing/collector/data/raw/*_messages.jsonl
State:     ~/ticketparsing/tools/.parse_state.json
"""

from __future__ import annotations

import json
import os
import sys
import time
import argparse
import logging
from dataclasses import asdict
from typing import List, Dict, Optional
from pathlib import Path

# Add parent dir so we can import the parser
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lottery_parser_v5 import parse_message, is_noise, load_jsonl_files

# Try importing requests; fall back to urllib if not available
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    import urllib.request
    import urllib.error
    HAS_REQUESTS = False

# ============================================================
# CONFIG
# ============================================================

COLLECTOR_RAW_DIR = os.path.expanduser("/opt/ticketparsing/collector/data/raw")
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".parse_state.json")
WORKER_URL = "https://ticket-api.officembx.workers.dev"
API_KEY = "D@ssw0rd123"
BATCH_SIZE = 50  # messages per API call

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("parse_upload")

# ============================================================
# STATE MANAGEMENT
# ============================================================

def load_state() -> dict:
    """Load parse state — tracks last processed line per JSONL file."""
    try:
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"files": {}}

def save_state(state: dict):
    """Save parse state atomically."""
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.rename(tmp, STATE_FILE)

# ============================================================
# API CLIENT
# ============================================================

def api_post(endpoint: str, payload: dict) -> dict:
    """POST JSON to Worker API. Returns response dict."""
    url = f"{WORKER_URL}{endpoint}"
    body = json.dumps(payload).encode("utf-8")

    if HAS_REQUESTS:
        resp = requests.post(url, json=payload, headers={
            "x-api-key": API_KEY,
            "Content-Type": "application/json"
        }, timeout=30)
        resp.raise_for_status()
        return resp.json()
    else:
        req = urllib.request.Request(url, data=body, headers={
            "x-api-key": API_KEY,
            "Content-Type": "application/json"
        }, method="POST")
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))

def api_reparse_wipe() -> dict:
    """Call the reparse endpoint to wipe parsed_entries (but keep messages)."""
    # We'll use a simple DELETE on parsed_entries via a custom call
    # Actually, let's just POST to the existing reparse endpoint which now does full wipe
    # But we want to skip the JS re-parsing. Let's do our own wipe via ingest-batch approach.
    # Simpler: just call reparse endpoint and let it clear, then we re-upload.
    # But that would also JS-reparse. Let's add a wipe-only param.
    # For now: we'll just upload with INSERT OR IGNORE — duplicates are handled.
    # For full reparse: use --reparse flag which tells the script to wipe state and re-upload all.
    pass

# ============================================================
# CORE LOGIC
# ============================================================

def read_jsonl_file(filepath: str, start_line: int = 0) -> List[dict]:
    """Read a JSONL file, optionally skipping already-processed lines."""
    messages = []
    with open(filepath, "r", encoding="utf-8") as f:
        for line_num, line in enumerate(f, 1):
            if line_num <= start_line:
                continue
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                obj["_source_line"] = line_num
                messages.append(obj)
            except json.JSONDecodeError as e:
                logger.warning(f"JSON error at line {line_num}: {e}")
    return messages

def parse_messages(messages: List[dict]) -> tuple:
    """Parse a list of messages using parser_v5. Returns (raw_messages, parsed_entries)."""
    stats = {
        "total_messages": 0,
        "messages_with_entries": 0,
        "messages_without_entries": 0,
        "skipped_noise": 0,
        "extracted": 0,
        "unknown_tokens": {},
    }

    raw_for_upload = []
    entries_for_upload = []

    prev_timeslot = None
    prev_group = None

    for msg in messages:
        stats["total_messages"] += 1

        # Build raw message record for DB
        raw_record = {
            "message_id": msg.get("message_id", ""),
            "whatsapp_timestamp": int(msg.get("whatsapp_timestamp", 0)),
            "group_jid": msg.get("group_jid", ""),
            "group_name": msg.get("group_name", ""),
            "sender": msg.get("sender", ""),
            "push_name": msg.get("push_name", ""),
            "text": msg.get("text", ""),
            "historical": msg.get("historical", False),
        }
        raw_for_upload.append(raw_record)

        # Parse
        entries, prev_timeslot = parse_message(msg, stats, prev_timeslot, prev_group)
        prev_group = msg.get("group_name", "")

        # Convert entries to DB format
        for entry in entries:
            entries_for_upload.append({
                "message_id": entry.message_id,
                "whatsapp_timestamp": entry.timestamp,
                "group_jid": msg.get("group_jid", ""),
                "group_name": entry.group_name,
                "sender": entry.sender,
                "push_name": entry.push_name,
                "lottery_type": entry.lottery,
                "timeslot": entry.timeslot,
                "bet_number": entry.number,
                "bet_type": entry.bet_type or entry.category,
                "quantity": entry.qty,
                "rate": entry.rate or 0,
                "price": entry.amount or ((entry.rate or 0) * (entry.qty or 1)),
                "raw_line": entry.raw_line,
            })

    return raw_for_upload, entries_for_upload, stats

def upload_batch(raw_messages: List[dict], parsed_entries: List[dict]) -> dict:
    """Upload a batch of raw messages + parsed entries to Worker."""
    payload = {
        "messages": raw_messages,
        "entries": parsed_entries,
    }
    return api_post("/api/ingest-batch", payload)

def process_file(filepath: str, start_line: int = 0) -> tuple:
    """Process a single JSONL file from start_line. Returns (messages_count, entries_count, last_line)."""
    filename = os.path.basename(filepath)
    messages = read_jsonl_file(filepath, start_line)

    if not messages:
        return 0, 0, start_line

    logger.info(f"  {filename}: {len(messages)} new messages (from line {start_line + 1})")

    raw_msgs, parsed_entries, stats = parse_messages(messages)

    # Upload in batches
    total_msg_inserted = 0
    total_entry_inserted = 0

    for i in range(0, len(raw_msgs), BATCH_SIZE):
        batch_raw = raw_msgs[i:i + BATCH_SIZE]

        # Collect entries for the messages in this batch
        batch_msg_ids = set(m["message_id"] for m in batch_raw)
        batch_entries = [e for e in parsed_entries if e["message_id"] in batch_msg_ids]

        try:
            result = upload_batch(batch_raw, batch_entries)
            total_msg_inserted += result.get("messages_inserted", 0)
            total_entry_inserted += result.get("entries_inserted", 0)
        except Exception as e:
            logger.error(f"  Upload failed at batch {i // BATCH_SIZE + 1}: {e}")
            # Return last successfully processed line
            if i > 0:
                last_processed = messages[i - 1]["_source_line"]
                return total_msg_inserted, total_entry_inserted, last_processed
            return 0, 0, start_line

    last_line = messages[-1]["_source_line"] if messages else start_line
    logger.info(f"  -> {total_msg_inserted} messages, {total_entry_inserted} entries uploaded")
    logger.info(f"  -> Parser stats: {stats['messages_with_entries']} with entries, "
                f"{stats['skipped_noise']} noise, {len(stats['unknown_tokens'])} unknown token types")

    return total_msg_inserted, total_entry_inserted, last_line

# ============================================================
# MAIN
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Parse local JSONL and upload to Cloudflare D1")
    parser.add_argument("--reparse", action="store_true",
                        help="Wipe all parsed entries in DB and reprocess everything")
    parser.add_argument("--date", type=str, default=None,
                        help="Process only a specific date file (YYYY-MM-DD)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse locally but don't upload to DB")
    args = parser.parse_args()

    logger.info("=== Parse & Upload Starting ===")
    logger.info(f"Source: {COLLECTOR_RAW_DIR}")
    logger.info(f"Target: {WORKER_URL}")

    # Check source directory
    if not os.path.isdir(COLLECTOR_RAW_DIR):
        logger.error(f"Source directory not found: {COLLECTOR_RAW_DIR}")
        sys.exit(1)

    # Load state
    state = load_state()

    # Handle --reparse: reset state so everything gets reprocessed
    if args.reparse:
        logger.info("REPARSE MODE: Wiping parsed entries in DB...")
        try:
            result = api_post("/api/reparse", {"wipe_only": True})
            logger.info(f"  DB wiped: {result.get('entries_deleted', '?')} entries deleted")
        except Exception as e:
            logger.error(f"  Failed to wipe DB: {e}")
            logger.info("  Continuing anyway — INSERT OR IGNORE will handle duplicates")

        # Reset state to force reprocessing all files
        state = {"files": {}}
        save_state(state)

    # Find JSONL files
    import glob as g
    if args.date:
        pattern = os.path.join(COLLECTOR_RAW_DIR, f"{args.date}_messages.jsonl")
    else:
        pattern = os.path.join(COLLECTOR_RAW_DIR, "*_messages.jsonl")

    files = sorted(g.glob(pattern))

    if not files:
        logger.info("No JSONL files found to process.")
        return

    logger.info(f"Found {len(files)} file(s) to check")

    total_messages = 0
    total_entries = 0

    for filepath in files:
        filename = os.path.basename(filepath)
        last_processed_line = state.get("files", {}).get(filename, 0)

        # Check if file has new content
        with open(filepath, "r") as f:
            total_lines = sum(1 for _ in f)

        if total_lines <= last_processed_line:
            continue  # No new data

        if args.dry_run:
            messages = read_jsonl_file(filepath, last_processed_line)
            raw_msgs, parsed_entries, stats = parse_messages(messages)
            logger.info(f"  {filename}: {len(raw_msgs)} messages -> {len(parsed_entries)} entries (dry run)")
            total_messages += len(raw_msgs)
            total_entries += len(parsed_entries)
            continue

        msg_count, entry_count, last_line = process_file(filepath, last_processed_line)
        total_messages += msg_count
        total_entries += entry_count

        # Update state
        if "files" not in state:
            state["files"] = {}
        state["files"][filename] = last_line
        save_state(state)

    logger.info(f"=== Complete: {total_messages} messages, {total_entries} entries ===")

if __name__ == "__main__":
    main()
