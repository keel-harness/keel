import type { AnyAuditRecordT } from "@keel/shared";

/** Inputs for the human-readable session replay. */
export interface ReplayInput {
  sessionId: string;
  records: readonly AnyAuditRecordT[];
  rootHash: string;
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** HTML-escape a string. Every record-derived value flows through this before it
 *  reaches the markup — the replay is escaped **by construction**, so hostile tool
 *  args / output cannot inject script or break out of a cell (Epic 2.7 security). */
function esc(s: string): string {
  // The character class only matches keys of HTML_ENTITIES, so the lookup is total.
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]!);
}

/**
 * Render the bundle's `replay.html` — the inspectable "here's exactly what the
 * agent did" code-review artifact (Appendix E). Honest-by-construction: every row
 * is rendered from an audit-chain record (Appendix B), never from model
 * self-report. This is the **renderable + inspectable** 2A pass; the beauty pass
 * is Epic 3.7 (out of scope).
 */
export function renderReplayHtml(input: ReplayInput): string {
  const rows = input.records
    .map((r) => {
      const verdict = r.policy ? esc(r.policy.verdict) : "";
      const payload = esc(JSON.stringify(r.payload));
      return `<tr><td>${r.seq}</td><td>${esc(r.ts)}</td><td>${esc(r.eventType)}</td><td>${esc(
        r.principal.osUser,
      )}</td><td>${verdict}</td><td><code>${payload}</code></td></tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>keel evidence replay — ${esc(input.sessionId)}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; color: #111; }
table { border-collapse: collapse; width: 100%; }
td, th { border: 1px solid #ccc; padding: 0.4rem; text-align: left; vertical-align: top; }
code { white-space: pre-wrap; word-break: break-all; }
.meta { color: #555; }
</style>
</head>
<body>
<h1>keel evidence replay</h1>
<p class="meta">Session <code>${esc(input.sessionId)}</code> · ${input.records.length} records · root <code>${esc(
    input.rootHash,
  )}</code></p>
<table>
<thead><tr><th>seq</th><th>time</th><th>event</th><th>principal</th><th>verdict</th><th>payload</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="meta"><em>Honest-by-construction: rendered from the audit chain (Appendix B). Re-verify via the bundle's <code>audit.jsonl</code> + <code>rootHash</code>.</em></p>
</body>
</html>
`;
}
