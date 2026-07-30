# 0008 — Session store: append-only JSONL with atomic rename snapshots

**Status:** accepted
**Date:** 2026-06-11

## Context
KEEL's kernel loop must persist session state durably so that interrupted sessions can be resumed, trajectory data is available for eval replay, and the audit chain has a complete record. The session store must handle concurrent writes safely (only one kernel process writes to a session at a time, but the file must be readable by diagnostic tools concurrently), survive process crashes without corruption, and be inspectable by humans and downstream tools without a special reader.

## Options
1. **Append-only JSONL event log + atomic rename for snapshots** — each event is a newline-delimited JSON object; snapshots are written to a temp file then atomically renamed over the snapshot path; simple, crash-safe, human-readable.
2. **SQLite database** — richer query support but overkill for a single-session append log; adds a native dependency for the session store (separate from the memory index use).
3. **Single large JSON file** — must be rewritten in full on every event; not crash-safe; grows unbounded; rejected.

## Decision
Adopt an append-only JSONL event log as the primary session store. Each session event (tool call, tool result, model turn, approval gate, policy decision, compaction event) is appended as a single JSON line. Snapshots (full session state) are written via atomic rename (`write to .tmp` → `rename to .snapshot`) to ensure readers never see a partial state. The session JSONL schema is defined in `@keel/shared` (Epic 0.2) and validated via zod at both write and read time.

## Consequences
Append-only writes are crash-safe by construction — a crash between appends leaves a valid partial log, not a corrupt file. The JSONL format is directly consumable by the `@keel/eval` trajectory store without conversion. Log compaction (when a session grows beyond a configurable size) must preserve the full event history, not discard it — compaction produces a new snapshot and trims the event log prefix, documented in the session schema. The JSONL schema version must be included in every record so future readers can handle format evolution.
