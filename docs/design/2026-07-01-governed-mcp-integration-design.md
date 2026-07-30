# Governed MCP Integration — Design Spec v2 (keel)

**Status:** historical design record, ratified through **ADR-0067** and the subsequent bounded
local-stdio implementation slices. Supersedes the earlier 2026-07-01 draft.
**Written against:** `MASTER_SPEC.md` v1.19. Nothing here changes a frozen interface; the two places a
future change *might* be warranted are named as reserved, ADR-gated seams (§10.1, §14 D-1).
**Thesis it must not break:** *autonomy at the reasoning layer, determinism at the control layer* (§1.1).
**Framing discipline:** this doc claims only what a named test proves (§12) and documents every gap it
does not close (§3.2). "Provably secure" here means what it means everywhere else in keel: structural
guarantees with enforcement in a separate process, each guarantee bound 1:1 to an adversarial test, and
every accepted limitation carried as a DOC-LIMIT with a documents-the-gap test — never a marketing
absolute.

---

## 0. What changed from the v1 draft (review deltas)

An independent security review of the draft found five high-severity and five medium-severity gaps.
All are incorporated. Agents implementing from this doc do not need the v1 draft; this list exists so
the ADR record shows *why* the design has this shape.

| # | Delta | Where fixed |
|---|---|---|
| 1 | Phase-3 provenance dependency was implicit; SEC-MCP guarantees over-claimed pre-P3 | §11 (hard gates), §3.1 (per-guarantee enforcement column), §7.1 (model-arg taint contract) |
| 2 | Quarantine step auto-executed stdio binaries / contacted remote hosts pre-grant | §4.1 (new lifecycle: no spawn/connect without a human `review` act) |
| 3 | Pin covered definitions, not code — mutable `npx` commands bypass rug-pull defense | §4.3 (version-pin requirement, entrypoint hash), DOC-LIMIT-MCP-2 |
| 4 | Server trust grant leaked its host into the general egress allowlist | §6.2 (channel-scoped egress grants) |
| 5 | Taint defense covered untrusted data only; workspace secrets (trusted, sensitive) could exit to a granted server | §5.3 (sensitivity-at-egress rule POL-012-MCP), SEC-MCP-05b |
| 6 | Resources and prompts were enumerated as attack surface but never governed | §1.2 (v1 = tools only, fail-closed; reserved Slice R) |
| 7 | Leaf-cert TLS pinning would manufacture consent fatigue on routine rotation | §4.4 (SPKI-of-key pin; rotation flow distinct from rug-pull), §6.3 (redirect policy) |
| 8 | Localhost / plain-HTTP "remote" servers escaped both the sandbox story and the TLS story | §6.4 |
| 9 | Server process lifecycle (spawn/supervise/kill) had no home — it is not a tool call | §6.5 (warden-owned supervisor, Epic-2.11 pattern) |
| 10 | Notifications/logging rendering and sampling recursion were unspecified | §7.4, §7.5 |
| — | Minor: JCS canonicalization cite; slug derivation + tool-name length; manifest↔pin binding; `roots` privacy; fixture corpus home; OQ resolutions | §4.5, §4.6, §5.2.4, §6.4, §12.2, §14 |

---

## 1. Scope

### 1.1 What MCP gives the model, in keel's threat vocabulary

- **Tools** — remote functions: JSON-Schema input contract, natural-language description, optional
  `annotations` (`readOnlyHint`, `destructiveHint`, `openWorldHint`). Return content blocks
  (text/image/audio/resource-link/embedded-resource) plus optional `isError` and `_meta`.
- **Resources** — server-addressable content via `resources/read`.
- **Prompts** — server-supplied prompt templates.
- **Transport** — `stdio` (local child process) or **Streamable HTTP** (remote). SSE is deprecated
  upstream and **not implemented** (its long-lived connection semantics also complicate egress
  accounting).
- **Server-initiated features** — `sampling`, `elicitation`, `roots`, notifications
  (`tools/list_changed`, `logging`, progress).

Every bullet is attack surface. The ecosystem's documented failure classes — tool-definition
poisoning, rug-pull redefinition, tool shadowing, confused-deputy egress, token passthrough, consent
fatigue, result-borne injection — each map to a structural answer below, or to a named DOC-LIMIT.

### 1.2 v1 surface: tools only (everything else fails closed)

**In scope (v1):** tool listing, tool invocation, `roots` (outbound, restricted — §6.4), notifications
(bounded — §7.4), server credentials via the secretless proxy (§8).

**Out of scope (v1), fail-closed, tested:**

- **Resources** — not advertised; `resources/read` is refused by the client with a typed error. A
  remote resource read is egress (the URI leaves) plus untrusted ingestion; it earns governance in a
  future slice (Slice R, §13), not a silent pass-through now.
- **Prompts** — not advertised, never fetched into context. A server prompt template is wholesale
  injection by design; if a future slice enables prompts, they enter the definition pin (§4.3) and
  render as untrusted data.
- **`sampling` / `elicitation`** — disabled by default and **not enable-able in v1** (no config knob
  ships until the gating in §7.5 is built). Off means structurally off: the client responds with a
  capability-not-supported error.

Rationale: the projection-seam claim (§2) is only honest if every advertised capability actually
traverses the warden. Shipping tools-only keeps the claim exact; each excluded capability has a
reserved design note so it is deferred, not forgotten.

### 1.3 The one-sentence architecture

An MCP tool call is lowered into the existing `warden.execute` path with a warden-synthesized
`SideEffect`, a real policy verdict, a sandbox profile, channel-scoped egress enforcement, provenance
tagging, and a hash-chained audit record — indistinguishable, at the trust boundary, from a governed
`bash` call — **or it fails closed**. MCP is a new tool *source*, not a new enforcement model. If any
part of this design ever needs a second policy engine, a `warden.execute` bypass, or a
"trust the server" flag, it is mis-scoped; stop and re-read §1.1 of the master spec.

### 1.4 Mapping to existing keel machinery

| MCP surface | Existing primitive | New work |
|---|---|---|
| Tool invocation | `warden.execute` per-action gate (§4.3 spec) | Synthesize `SideEffect` for an opaque call (§5) |
| Definition ingestion | Trust-before-parse (§3.2.4, SEC-012) | Registration chokepoint + pin (§4) |
| Server as local process | Sandbox profiles (§3.2.1), SEC-017 ulimits | Sandbox the server itself; warden-owned supervisor (§6) |
| Server as remote endpoint | Egress allowlist + warden proxy | Channel-scoped host grant; args are egress payload (§6.2–6.3) |
| Tool results | Provenance-at-ingestion (§3.2.5), taint (§4.7.8) | Results default `untrusted`; `_meta`/resource-link taint inheritance (§7) |
| Server auth | Secretless proxy (SEC-027, ADR-0066) | Applied verbatim to server tokens (§8) |
| Approvals / modes | §4.9 postures, §4.9.3 grant scopes | Per-server + per-tool scopes; pin-flap distrust (§9) |
| Audit / evidence | Hash-chained audit (Appendix B), bundle (Appendix E) | Open `payload` markers only; pinned definitions in bundle (§10) |
| Secrets egress | §4.8 target `sensitivity` axis | Pack rule POL-012-MCP: secret-sensitivity → opaque/external boundary reviews (§5.3) |

The right column is deliberately small. That is the design.

---

## 2. Invariants (the contract every section below serves)

1. **One enforcement model.** No MCP code path executes an effect without the warden when the warden
   is present (`--yolo` is ungoverned *and says so loudly*, like every tool — honest-YOLO).
2. **Nothing a server says is authority.** Descriptions, schemas, annotations, results, notifications,
   log lines, elicitation text: all data, never instructions to keel and never policy inputs that can
   widen an envelope or downgrade a verdict.
3. **Nothing runs or connects before a human act.** Workspace trust authorizes *reading* MCP config; it
   does not authorize executing a binary named in it or contacting a host named in it (§4.1).
4. **Unknown fails closed.** An effect the warden cannot classify inherits the `bash`-equivalent broad
   envelope and the conservative-confidence path (§5.1); narrowing is earned through trusted,
   pinned, audited declarations — never through server self-report.
5. **Honest claims only.** Every guarantee in §3.1 names its enforcement mechanism *and the phase that
   mechanism ships in*. A guarantee whose mechanism is Phase 3 is not claimed for a slice that ships
   before Phase 3 (§11).

---

## 3. Threat model delta (extends spec §3; does not replace it)

### 3.1 Structural guarantees (each 1:1 with a §12 test; enforcement mechanism named)

Numbering continues §3.2 of the spec (cite as §3.2-MCP-N).

| # | Guarantee | Enforcement mechanism | Live from |
|---|---|---|---|
| 1 | No MCP server process is spawned, and no MCP host is contacted, before an explicit human **review request** for that server; no tool is advertised before an explicit **trust grant** | Lifecycle chokepoint (§4.1); config parse produces inert entries only | Slice 1 |
| 2 | The model cannot self-authorize an MCP effect; server annotations may narrow a *candidate* envelope but never widen the enforced one or downgrade a verdict | Envelope synthesis precedence (§5.1–5.2); warden-side, annotations advisory | Slice 1 |
| 3 | Definitions cannot change enforcement, and cannot change silently: any post-grant definition change re-quarantines and requires human re-grant with an audited diff | JCS pin + rug-pull re-quarantine (§4.3–4.4) | Slice 1 |
| 4 | A local stdio server runs with no more authority than a sandboxed `bash` process: workspace-scoped writes, secrets deny-read, egress only via the warden proxy under its own channel-scoped allowlist, ulimits, per-server namespace | Warden-owned supervisor + `SandboxPort` profile (§6.1, §6.5) | Slice 1 |
| 5 | Remote MCP egress is channel-scope allowlisted; the host grant authorizes the MCP transport for that server only — no other tool inherits it, and no other host is reachable | Channel-scoped grant table in warden proxy (§6.2) | Slice 2 |
| 5b | Secret-sensitivity data (per the §4.8 `sensitivity` axis) crossing into an opaque MCP call or remote transport triggers review/deny — independent of trust-taint | POL-012-MCP pack rule + argument scan (§5.3) | Slice 1 (local), Slice 2 (remote) |
| 6 | MCP results are untrusted-by-default; result-borne instructions cannot cause un-reviewed egress or a trust upgrade; `_meta`/resource-link follow-on actions inherit the originating result's taint | Provenance tagging + POL-011 (Phase 3) **plus** slice-local structural mitigations pre-P3 (§7.2, §11) | Format from Slice 1; enforced with Epic 3.1 |
| 7 | Server credentials never enter model context, tool args, session JSONL, audit, receipts, or TUI; wrong-host / placeholder replay fails closed | Secretless proxy, ADR-0066 verbatim (§8) | Slice 1 |
| 8 | Malformed / oversized / adversarial server bytes never crash the kernel or warden; typed errors only | Strict boundary parse + size caps + fuzz corpus (§6.6) | Slice 1 |
| 9 | Server-initiated `sampling`/`elicitation` are structurally off in v1 (capability-not-supported), not merely defaulted off | Client capability negotiation (§7.5) | Slice 1 |
| 10 | A server cannot shadow a built-in or another server's tool, by name or by advertised description | keel-assigned slug namespace (§4.6) | Slice 1 |

### 3.2 Documented limits (each carries a DOC-LIMIT id + documents-the-gap test; never hidden)

- **DOC-LIMIT-MCP-1 — sanctioned action.** Granting a "delete-my-production-database" server and
  approving the call is audited and sandboxed, not prevented. Governance bounds *unintended*
  authority.
- **DOC-LIMIT-MCP-2 — code is not pinned.** The definition pin (§4.3) pins what the server *says*,
  not what it *is*. A server whose code changes under an identical command string and identical
  definitions (registry re-publish, mutable tag) is bounded by its sandbox envelope, not detected by
  the pin. Concretely, for `command: /usr/local/bin/node` with `server.mjs` in `args`, the resolvable
  entrypoint hash covers the Node executable; changing only `server.mjs` bytes while argv and
  advertised definitions stay identical is not detected. Mitigations: version-pin requirement +
  unpinned-command warning + configured-command executable hash where resolvable (§4.3). Structural
  fix class: same as spec §3.3 "kernel compromise via dependencies."
- **DOC-LIMIT-MCP-3 — granted-channel exfiltration.** A server granted read of the workspace can read
  the workspace; data that legitimately exits to its granted host is outside keel's boundary
  (spec §3.3 allowlist-granularity, SEC-022 class). Mitigations: provenance review (P3) +
  POL-012-MCP sensitivity review. Structural fix: request-level egress filtering (Phase 4 item 2).
- **DOC-LIMIT-MCP-4 — in-kernel client parser (v1).** The MCP client parses untrusted server bytes in
  the key-holding process in Slice 1–3. Mitigated per §6.6; structurally closed by Slice 4
  (client-in-warden).
- **DOC-LIMIT-MCP-5 — localhost origins.** A granted `http://localhost:*` server is local code keel
  did not spawn and cannot sandbox; only the connection is governed (§6.4). Denied by default;
  explicit high-friction override.
- **DOC-LIMIT-MCP-6 — pre-P3 result taint.** Until Epic 3.1 lands, result taint is recorded
  (format seam, §4.7.8 spec) but not policy-enforced; Slice-1 structural mitigations in §7.2 bound
  the gap, and Slice 2 is hard-gated on Epic 3.1 (§11).

Per the §8.1 rule: a claim with no test is deleted; a limit with no test is silent.

---

## 4. Registration: the server lifecycle chokepoint

This is the design's most important idea: SEC-012's trust-before-parse, extended from project files to
tool definitions — **and now to process execution and network contact**.

### 4.1 Lifecycle (v2 — human act before any spawn/connect)

```
configured ──(human: `keel mcp review <server>`)──▶ quarantined(fetched, candidate-pinned)
                                                         │
                                     (human: grant) ─────▶ trusted(pinned) ──▶ advertised ──▶ callable
                                                         ▲                                      │
                 rug-pull / pin mismatch ────────────────┘        every call ⟶ warden.execute ──┘
```

- **configured** — the server appears in `.keel/mcp.json` (project scope) or `~/.keel/mcp.json`
  (user scope), read only after workspace trust through the `ProjectReader` chokepoint (Epic 1.7).
  A configured entry is **inert data**: keel spawns nothing, connects nowhere, renders only the
  config's own literal fields in `keel mcp list`. *Workspace trust authorizes reading this file; it
  does not authorize executing a binary or contacting a host named in it.* This closes the
  trust-class collapse that ADR-0026 refused for extensions.
- **review request** — the human runs `keel mcp review <server>` (or accepts the equivalent TUI
  prompt). This single act authorizes exactly one thing: a **bounded, sandboxed discovery
  connection** — for stdio, spawning the server inside its sandbox profile (§6.1) to call
  `initialize` + `tools/list`; for remote, one TLS connection to the configured origin (a one-time,
  channel-scoped, discovery-only egress grant) to do the same. Discovery is read-only at the MCP
  layer: no tool is invoked, nothing is advertised, no result enters model context.
- **quarantined** — fetched definitions land in an inert registry. Descriptions are **not** injected
  into any prompt. keel computes the **candidate pin** (§4.3) and renders the one-screen review
  summary (§9.1).
- **trusted(pinned)** — the human grants. The candidate pin becomes the stored pin, persisted in
  **user or project scope config, never project-file scope** (same rule as workspace trust and
  autonomy mode). The channel-scoped egress grant (§6.2) is recorded.
- **advertised** — only now do the server's tools enter the model's toolset, namespaced per §4.6.
- **callable** — every invocation lowers to `warden.execute` (§5). A trust grant is *not* an
  invocation grant (§9.1).

Timeouts and crashes during discovery return the server to `configured` with a typed error; there is
no half-quarantined state.

### 4.2 Rug-pull / redefinition defense

MCP permits `tools/list_changed`. Defense:

- Every `tools/list_changed`, every reconnect, and every session start with a trusted server
  re-fetches definitions and recomputes the pin.
- **Pin mismatch → automatic re-quarantine.** Changed tools leave the advertised set immediately
  (mid-session: in-flight calls complete under their already-issued verdicts; no new calls). The
  human sees a per-tool diff of `{name, inputSchema, description, annotations}` — one line each —
  and must re-grant. **No auto-accept of a definition change, ever** — not under Project Autopilot
  (modes govern invocation prompts, never definition trust).
- The diff is audited (`payload.mcpPinDelta`, §10).
- **Pin-flap distrust:** a server that trips re-quarantine ≥ N times (default 3) in a rolling window
  is marked `distrusted` — its next state after re-quarantine requires `keel mcp review` from
  scratch, and the review screen says why. This converts "wear the human down" into "lose trust
  entirely" (§9.2).

### 4.3 The pin (what is hashed, and what is honestly not)

The pin is a hash over the **JCS / RFC 8785 canonical JSON** (per ADR-0006 — same canonicalizer as
the audit chain; the schema owns array ordering) of:

- every tool's `{name, inputSchema, description, annotations}`;
- server identity:
  - **stdio:** configured command string + argv + relevant env keys (names only, never values);
    **plus the SHA-256 of the resolved configured-command executable where resolvable**. Files
    referenced only through argv, interpreter loaders, and transitive imports are not covered
    (DOC-LIMIT-MCP-2);
  - **remote:** origin URL + the **SPKI hash of the server's public key** (§4.4);
- the negotiated MCP protocol version and the server's declared capability set (so a server cannot
  silently gain `sampling` capability post-grant).

**Version-pin requirement (mitigates DOC-LIMIT-MCP-2):** at review time keel classifies the stdio
command as *version-pinned* (`pkg@1.2.3`, an absolute path, a lockfile-resolved binary) or
*floating* (`npx -y pkg`, `pkg@latest`, a bare PATH lookup). Floating commands are **not blocked**
(that would be dishonest theater — the pin cannot verify code either way) but the grant screen
carries a persistent warning line, the audit records `mcpCommandPinning: "floating"`, and the curated
allowlist (§5.2.4) accepts only version-pinned entries. What the pin does and does not cover is
stated on the grant screen in one sentence.

### 4.4 Remote identity: SPKI pin, rotation ≠ rug-pull

- The pin captures the **SPKI hash of the server's public key**, not the leaf certificate. Routine
  ACME renewals that re-certify the same key change nothing.
- A **key** change (SPKI mismatch) with *unchanged definitions* triggers the **rotation flow**: a
  calm, distinct re-confirmation ("server key rotated; origin and tool definitions unchanged;
  confirm to update pin") — deliberately different in tone and framing from definition rug-pull,
  which is the high-alarm flow. Both are audited; neither is auto-accepted. Rationale: routine-churn
  alarms train click-through and destroy the alarm that matters (§9.2 consent-fatigue budget).
- Standard WebPKI validation applies in addition to (never instead of) the SPKI pin.

### 4.5 Description hygiene

- Description text shown to the model is **length-capped and rendered as data** (ER-020: model/tool
  output is never a format string). Over-cap text is truncated with an explicit marker; the full
  text is available to the human reviewer, never silently injected at full length.
- Grant-time heuristics — imperative sentences addressed to "the assistant", embedded
  `<system>`-like tokens, unicode-tag smuggling, invisible characters — raise an advisory **review
  flag** on the grant screen. Advisory to the human, never a policy input (invariant 2), never a
  silent block.

### 4.6 Namespacing, slugs, and name-length collisions

- Advertised name: `mcp__<serverId>__<toolName>`. `serverId` is **keel-assigned**: the config key
  name, slugified `[a-z0-9-]`, uniqued across user+project scope by suffixing `-2`, `-3`… in
  deterministic (user-scope-first, then declaration-order) precedence. A server never chooses its
  own slug, so it cannot shadow `bash`/`read`/… or another server. Built-ins always win the bare
  namespace; a server tool literally named `bash` advertises as `mcp__<slug>__bash` and nothing
  else.
- **Provider name limits:** if the composed name exceeds the active provider's tool-name limit
  (recorded in the ADR-0030 capability table), the tool name segment is truncated and suffixed with
  6 hex chars of its own hash — deterministic, collision-checked within the advertised set, and the
  mapping is shown in `keel mcp list` and recorded in audit payloads so evidence stays
  reconstructable. Truncation never applies to the `mcp__` prefix or the slug.
- Two scopes configuring the *same* server identity (same command/origin) under different keys are
  detected at review time and surfaced ("also configured as X in user scope") to avoid duplicate
  trust decisions diverging.

---

## 5. Synthesizing a `SideEffect` for an opaque call

The §4.8 taxonomy assumes the kernel declares a static envelope and the warden resolves a dynamic
effect from inspectable arguments. An MCP call's real effect is defined by code the warden cannot
read. So the default inverts: **opaque ⇒ maximal envelope ⇒ fail closed**, with trusted, audited
paths to *narrow*.

### 5.1 Static capability envelope (precedence: most conservative wins)

1. **Floor (no reliable signal):** `broad: true`; `effectEnvelope` = the full primitive set
   (`fs_read fs_write process_exec network_read network_write`); scopes include `external_service`.
   An unknown MCP tool is treated as at least as dangerous as `bash`.
2. **Transport floor (cannot be narrowed away):** any *remote*-server tool carries at minimum
   `network_write + network_read` scoped `external_service` to the server's granted host — arguments
   leave the machine and results return, regardless of what the tool claims to do. A *stdio*-server
   tool carries the server sandbox's own envelope as its ceiling (§6.1).
3. **Server annotations — untrusted, candidate-only:** `readOnlyHint: true` lets keel record a
   *candidate* narrower envelope, displayed to the human at grant/review time. **The enforced
   envelope never moves off the floor because of an annotation.** Annotations are advisory metadata,
   exactly like a model's self-classification, which §4.8 already forbids from dodging policy.
4. **Capability manifest — the trusted narrowing path:** the human, or a signed policy/capability
   pack, declares per-tool envelopes in `.keel/mcp.capabilities.yaml` (user/project scope; the
   ADR-0056 one-source-of-truth idea applied to MCP): e.g. *"`mcp__github__get_issue` is
   `network_read` to `api.github.com`, no fs, no writes."* A declared envelope narrows the floor,
   is itself JCS-hashed, **bound to a specific definition pin** (§5.2.4), and audited. This is how
   mature deployments earn quiet, precise governance without ever trusting the server's word.

### 5.2 Dynamic resolved effect per invocation

For each call the warden computes `dynamic{…}` from what it *can* see plus the envelope:

1. **Argument scan.** Recursively walk the args object: (a) filesystem-path-shaped values →
   resolve, bound to workspace, tag `sensitivity` per the §4.8 axis
   (`public · internal · secret · unknown`); (b) URL/host-shaped values → normalize, check against
   the server's channel-scoped grants (§6.2); (c) provenance of every value per the taint state
   (Phase 3; §7.1, §11).
2. **Composition.** An MCP call is represented as `composition.kind: "atomic"` with classifier
   `reason: "mcp_opaque"` — **no new frozen enum value in v1** (resolved OQ-MCP-1, §14). The
   exfiltration-derivation logic treats an opaque external call carrying secret- or
   untrusted-tagged args exactly as it treats a data-carrying pipe to an external host.
3. **Confidence.** `classifier.confidence = "conservative"` at best. Opaque maps into the existing
   "fails closed → non-retryable, review/deny per posture" rule; nothing MCP-sourced reaches
   `exact` in v1, and no MCP call is ever auto-retry eligible (`isRetryEligible` requires
   affirmatively resolved fs reads — an opaque call can never satisfy it; add the regression test
   anyway, SEC-MCP-11).

### 5.3 Sensitivity at egress: POL-012-MCP (closes the trusted-secrets gap)

POL-011 gates **untrusted-derived** data at egress. It does not gate the highest-value target:
workspace secrets, which are `workspace`-trusted. The §4.8 taxonomy already carries the needed axis
(target `sensitivity: secret`); what is missing is one pack rule:

> **POL-012-MCP** *(default pack; non-frozen; ships Slice 1):* an argument (or resolved argument
> target) carrying `sensitivity: secret` — or resolving under a deny-read/secrets path even when
> readable — crossing into (a) any remote MCP transport, or (b) any opaque (`mcp_opaque`) tool call,
> triggers **review** (Guided/Autopilot) and **deny** under postures that deny secrets. `unknown`
> sensitivity on an external-bound argument triggers review under Guided.

This is trust-independent: it fires on *what the data is*, not where it came from. It is the reason
the obvious attack — injected model reads `.env` (workspace-trusted, readable), calls
`mcp__x__log_event` with the contents — reviews in Slice 1, before Phase-3 taint exists.
Sensitivity classification reuses the existing path/env classifier (deny-read lists, provider-key
formats, entropy heuristic from Epic 1.9's redaction filter); it is heuristic, so this rule is a
mitigation layer *under* the sandbox deny-read (which remains the primary secrets defense), never a
replacement. Test: SEC-MCP-05b.

### 5.4 Why this is honest

The taxonomy's contract is "the model requests; the warden decides; unknown fails closed." An
undeclared MCP tool inherits the `bash`-equivalent broad envelope, so the *default* MCP experience is
appropriately gated (broad ⇒ Guided reviews; Autopilot still reviews the risky classes), and teams
get a **trusted, auditable narrowing path** (the manifest) to earn quiet — mirroring exactly how
ecosystem presets earn prompt-free `npm install`, and never trusting self-report.

---

## 6. Server execution: sandbox the server, govern the channel

### 6.1 Local (stdio) servers

A stdio MCP server **is arbitrary local code** and must never hold more authority than a sandboxed
`bash` process:

- Launched (by the warden supervisor, §6.5) inside a `SandboxPort` profile
  (bubblewrap/Seatbelt): allow-write {workspace, per-server tmp}; deny-read {`~/.ssh`, `~/.aws`,
  `~/.gnupg`, keel config + audit dirs, credential source files, **other servers' dirs and tmp**};
  egress **only** through the warden proxy under the server's own channel-scoped allowlist (§6.2);
  resource ulimits (SEC-017 class).
- **Per-server namespace:** each server gets its own sandbox namespace, distinct from the agent tool
  sandbox and from every other server. A compromised server cannot read another server's tokens or
  the agent's secrets.
- The **discovery spawn** (§4.1) runs under this exact profile with a discovery-tightened egress
  allowlist (stdio discovery: none).
- `roots` advertised to a stdio server are exactly its sandbox's writable roots — never wider.
  `roots` is descriptive of an already-enforced boundary, not a request; a server asking for broader
  roots gets the same list back.
- Lifecycle (spawn, crash, kill, restart) is audited (§10). A crashed server halts its tools with
  honest absence — like a dead warden halts execution — and never degrades to ungoverned.

### 6.2 Channel-scoped egress grants (closes the allowlist-leak)

A server trust grant records its host in a **channel-scoped grant table**, keyed
`(serverId → {host set})`, enforced at the warden proxy:

- The grant authorizes **only** the MCP transport (and, for stdio, the server's sandboxed process
  egress) for **that server**. It is **not** an entry in the general egress allowlist: `bash`,
  `fetch`, other tools, and other servers do **not** inherit it. Trusting a server whose origin is
  `api.notion.com` must not silently open `api.notion.com` to the rest of the session.
- Symmetrically, a server's sandbox reaches **only** its own granted hosts — not the session
  allowlist. Default for a stdio server: empty (a local server that needs egress declares hosts in
  config; each is shown at grant time and granted per-server).
- Grant persistence and revocation ride the existing grant mechanism and scopes
  (`once`/`project`, ADR-0033) with a `payload.mcpChannel` marker; the frozen grant-scope schema is
  untouched.

### 6.3 Remote (Streamable HTTP) servers

- Origin granted per-server, channel-scoped (§6.2). No implicit trust from config presence; even the
  discovery connection requires the human review act (§4.1).
- Identity: SPKI pin + WebPKI (§4.4).
- **Redirect policy: cross-origin redirects are refused** (typed error). A redirect is an origin
  swap; following it would bypass both the pin and the grant. Same-origin path redirects are
  followed to a bounded depth.
- **Outbound arguments are egress payload.** They traverse POL-006 (network write to a domain —
  which, per the spec, is *not* satisfied by domain allowlisting alone), POL-012-MCP (§5.3), and —
  once Epic 3.1 lands — POL-011 (tainted-egress review). This is the confused-deputy defense: the
  model cannot launder secrets or untrusted-derived data to a granted server without a check firing.
- Only Streamable HTTP. SSE not implemented.

### 6.4 Localhost and non-TLS origins (DOC-LIMIT-MCP-5)

- **TLS is required for all non-localhost origins.** `http://` to a non-localhost host is refused
  outright (not review — refused; there is nothing to pin).
- **Localhost origins are denied by default.** A localhost HTTP server is local code keel did not
  spawn and cannot sandbox: §6.1's containment story simply does not apply, and localhost is the
  known MCP DNS-rebinding surface. Enabling one requires an explicit per-server config flag plus a
  high-friction grant screen stating exactly this ("keel governs the connection to this process,
  not the process"). When enabled: `Origin` header validation on every request, loopback-address
  literal required (no hostnames that could rebind), SPKI pin still captured if TLS, and the
  DOC-LIMIT is named on the grant screen.
- **`roots` are not sent to remote servers** (including localhost-remote) in v1. Workspace paths
  leak usernames and project names to an external party before any tool call; a remote server that
  needs scoping information gets it through explicit tool arguments the human can see, not through
  protocol furniture. (Reserved seam: a redacted-roots option if a real server need appears.)

### 6.5 The supervisor: where server lifecycle lives (not `warden.execute`)

Spawning, supervising, and killing a server process is not a tool call, and Appendix A
(`WARDEN_METHODS`) is frozen. The home is the **Epic 2.11 pattern**, reused deliberately:

- The **kernel** owns intent: it reads config (post-trust), drives the lifecycle state machine
  (§4.1), and forwards **secret-free, parent-side server config** (command/argv/env-key-names/origin
  + the stored pin + the channel grant set) to the warden at spawn time — exactly how the lifecycle
  manifest is forwarded today.
- The **warden** owns execution: it spawns the server under the sandbox profile, holds the
  supervision handle, runs the egress proxy channel, performs credential injection (§8), and kills
  on session end / re-quarantine / crash policy. There is **no kernel-side spawn path**; the
  architectural no-bypass test (§6.7) covers process creation, not just tool calls.
- Transport frames flow kernel ⇄ warden over the existing RPC boundary as opaque, size-capped
  payloads in v1 (client parse in-kernel, §6.6); Slice 4 moves parsing warden-side without changing
  this ownership split.
- Supervision events are audited via existing events + `payload` markers (§10): no new frozen
  `eventType`.

### 6.6 The client parser (DOC-LIMIT-MCP-4 and its closure)

- **v1 (Slices 1–3):** the MCP client (JSON-RPC framing, schema parse) runs in-kernel with the same
  discipline as the warden RPC boundary: strict zod-at-the-boundary parsing of every server message,
  hard size caps per frame and per session, no `eval`/dynamic schema execution, and a fuzz corpus
  (SEC-018 sibling; SEC-MCP-08) in CI from day one.
- **Slice 4 (recommended for the security-P0 posture):** move client transport + parse into the
  warden (or a dedicated broker) so untrusted server bytes never touch the key-holding process —
  the natural companion to the Rust warden port (Phase 4 item 1). ADR-flagged; does not block v1.

### 6.7 No bypass, tested structurally

The client lives behind an `McpExecutorPort` that lowers a validated call into
`warden.execute {toolCall: {name: "mcp__…", args}, provenanceContext}`. Two architectural tests, same
grep/AST + runtime-instrumentation approach as Epic 1.8/3.4: (1) no code path invokes MCP transport
send for a tool call except through the port's warden lowering; (2) no code path spawns an MCP server
process except the warden supervisor. Under `--yolo`: ungoverned and loudly labeled, like every tool.

---

## 7. Results, taint, and server-initiated traffic

### 7.1 Default taint — and the model-argument taint contract (constraint on Epic 3.0/3.1)

Every MCP result block — text, embedded content, resource-links, and especially `_meta` — enters
context tagged `untrusted` (format seam live since Phase 1, §4.7.8). A result is exactly a fetched
web page: it can inject the model; it must not be able to cause un-reviewed egress or a trust
upgrade. Declassification is only the existing scoped, audited, human flow (SEC-020) — never the
server asserting safety, and `openWorldHint` never matters (absent or present, results are
untrusted).

**Contract this design imposes on the Phase-3 provenance design (record in ADR-0067 and
`docs/design/provenance.md`):** *model-generated argument text is tainted at least `mixed` whenever
untrusted content is present in the model's context window at generation time.* If model output can
launder to trusted by paraphrase, then "tainted args → review" is theater: the injected model simply
retypes the untrusted data into the args and SEC-MCP-05's test passes while the real attack succeeds.
Conservative context-level taint of model-authored arguments is the minimum semantics under which
§3.1 guarantee 6 and the confused-deputy defense are true. This constraint is cheap to state now and
expensive to retrofit; it is the single most important sentence in this section.

**Follow-on inheritance:** a resource-link or `_meta`-triggered follow-on tool call inherits the
originating result's taint. A server cannot hand back a link that, when followed, executes a fresh
call laundered as trusted — the MCP form of compaction laundering (SEC-023). Test: SEC-MCP-06.

### 7.2 Pre-P3 structural mitigations (what Slice 1 relies on instead of taint enforcement)

Until Epic 3.1, taint is recorded but not policy-enforced (DOC-LIMIT-MCP-6). Slice 1 is safe anyway
because its risk is bounded structurally, not behaviorally:

- stdio-only: no remote transport ⇒ no argument egress to a server-controlled host;
- the server sandbox egress allowlist defaults to empty ⇒ a malicious local server has no channel;
- **resource-links in results are not followed in Slice 1** — rendered as inert text with an
  explicit marker (not just "not followed as trusted" — not followed at all);
- POL-012-MCP (§5.3) gates secret-sensitivity args into opaque calls from day one;
- session egress for *other* tools remains governed exactly as today, so result-borne injection
  aiming at `bash`-driven exfiltration hits the existing Phase-2 defenses.

Slice 2 (remote) removes the first two bounds, which is precisely why it is hard-gated on Epic 3.1
(§11).

### 7.3 Result size and shape

MCP results flow through the standard large-output handling (§4.7.9): head/tail into context, full
body persisted as a hashed artifact, truncation never claimed as full inspection, `retrieve(ref)` for
expansion. This also bounds a server's context-flooding / attention-exhaustion DoS. Frame- and
session-level size caps (§6.6) bound it below that.

### 7.4 Notifications and server logging are attacker-controlled text

- Server `logging` and progress notifications **never enter model context** in v1.
- When surfaced in the TUI they are **server-attributed and visually distinct** — rendered as data
  in a labeled server pane/prefix (`[mcp:github]`), never in keel's own voice or status line. A
  server must not be able to print `keel: enforcement disabled` and have it look like keel said it.
  Same ER-020 rule as everywhere: output is data, never a format string; control bytes stripped.
- `tools/list_changed` triggers §4.2. Unknown notification types are dropped with a debug-level
  audit marker, not surfaced.

### 7.5 `sampling` and `elicitation`: structurally off in v1

Both are answered `capability not supported` at negotiation (guarantee 9). No config knob ships in
v1 — a knob that exists gets flipped, and the gating below is real work that must not be improvised.
Reserved design (for the future slice that enables them, recorded now so it is not re-litigated):

- **`sampling`:** per-server opt-in; sampled completions are **tool-less and single-shot** (a sampled
  request that could invoke tools would be a governance-bypass loop); provenance-checked (no
  untrusted-tainted context forwarded without review); budget-capped under ADR-0044 accounting;
  fully audited.
- **`elicitation`:** per-server opt-in; rendered server-attributed as untrusted data
  ("SERVER X asks: …"), never in keel's voice; never pre-fills; credential-class requests are
  refused and routed to the credential flow (§8) — noting honestly that "credential-class" detection
  is heuristic, so the rendering rule (attribution + never-keel's-voice) is the load-bearing
  defense, and the residual social-engineering risk stays documented (§3.2 last row class).

---

## 8. Credentials: the secretless proxy, verbatim (ADR-0066 / SEC-027)

MCP's primary documented auth failure is token passthrough. keel already solved this shape; apply it
without invention:

- Server auth material is declared in `.keel/mcp.json` as a **source** (`{env|file|command}`), never
  a literal; resolved **parent-side (warden)**; bound to the server's granted host.
- Injected into the outbound transport at the proxy boundary; **never** present in tool args, model
  context, session JSONL, audit records, receipts, or TUI (never-serialize invariant). Command
  sources restricted to argv-only absolute commands, per the accepted ADR-0066 posture.
- Placeholder replayed to a wrong host ⇒ 403, fail closed. Source files are deny-read from every
  sandbox (agent tools and all servers, §6.1).
- **OAuth authorization-code flows:** the browser/consent step is a *prohibited agent action*
  (credential entry / OAuth grant class); the human completes it out-of-band; keel stores only the
  resulting token via the source mechanism. keel never drives a consent screen.

SEC-MCP-07 is deliberately mostly a re-run of the SEC-027 corpus against an MCP target.

---

## 9. Approval UX, grants, consent fatigue

MCP's real-world failure mode in other clients is consent fatigue → blanket allow → model collapse.
keel's counter is structural containment (fewer prompts needed), scoped grants, batching (§4.9.3),
and — new here — making trust *lose-able* (§4.2 pin-flap).

### 9.1 Three human acts, three meanings

1. **Review request** (`keel mcp review <server>`) — authorizes one sandboxed discovery connection.
   Nothing more (§4.1).
2. **Server trust grant** (coarse, rare) — moves `quarantined → trusted`: pins definitions, records
   the channel-scoped host grant. One screen: transport; origin/command (+ pinning classification
   and the floating-command warning, §4.3); tool count with synthesized envelopes and any candidate
   annotation narrowing *labeled as unenforced*; egress hosts; description-hygiene flags (§4.5);
   requested capabilities; what the pin does and does not cover, in one sentence. Persisted
   user/project scope; audited (`trust.grant` + `payload.mcpServer`).
3. **Tool invocation grant** (fine) — when `mcp__X__tool` hits `review`, the human sees
   `once / session / deny / explain` with a one-line blast radius. `session` is the existing
   kernel-side construct (ADR-0033), audited per application. Durable project grants use the
   explicit Project Autopilot configuration path and are not offered as a live-review shortcut
   (ADR-0073).

**A server trust grant is not an invocation grant.** Trusted means *advertised and
callable-through-the-warden*; each risky invocation still resolves a verdict. A broad/opaque tool
under Guided reviews; under Autopilot the contained classes proceed and the
destructive/secret/tainted-egress classes still review — identical to built-ins. This is what stops
"I trusted the server once" from becoming "the server can do anything."

### 9.2 Consent-fatigue budget

- §4.9.3 review-queue batching and the SEC-021 prompt budget apply to MCP prompts unchanged. A chatty
  server surfaces as a count, not an interrupt storm.
- Routine-churn flows are tonally separated from alarms (§4.4 rotation vs rug-pull) so alarms keep
  meaning.
- Repeat pin-mismatch ⇒ **distrust**, not repeat prompting (§4.2). The system's answer to a server
  that wears the human down is to stop asking and start refusing.
- No "treat as read-only, I vouch" express grant exists (resolved OQ-MCP-3, §14): it is the
  consent-fatigue foothold, and the curated manifests (§5.2.4) remove the legitimate demand for it.

### 9.3 Autopilot / Project Autopilot

Auto-proceed is a function of *synthesized side-effect class + verdict + sandbox tier + trust +
provenance + grants* — never server hints, never model confidence (§4.9.2 spec). An opaque tool does
not auto-proceed for risky classes; a **manifest-declared** read-only tool can earn Autopilot quiet,
the same way a known-safe test command does. Definition trust (§4.2) is never mode-governed.

### 9.4 Curated server allowlist (resolved OQ-MCP-4: yes, bound to pins)

Ship a small keel-verified set (≤ 12, the Epic 1.7 curation discipline) of common servers with
pre-written capability manifests. Binding rule: **each curated manifest is valid only for a specific
definition-pin hash and a version-pinned command/origin.** A server update changes the pin, which
detaches the manifest (tools fall back to the floor) until the curated entry is re-verified — an
unbound manifest is a trust statement about code nobody has seen. This is the ecosystem-presets
analogue and the single biggest legitimate consent-fatigue reducer.

---

## 10. Audit, evidence, frozen-interface discipline

### 10.1 No frozen change in v1 (the constraint that keeps this shippable)

Following the pattern steering, lifecycle, goal/loop, and model-routing already used: **MCP adds no
Appendix A method, no Appendix B `eventType`, no frozen `SideEffect` primitive, and no grant-scope
change.** It rides:

- **`warden.execute`** unchanged — `toolCall.name` is `mcp__…`; the synthesized `SideEffect` uses
  existing axes; opacity is `composition.kind:"atomic"` + classifier `reason:"mcp_opaque"` +
  `confidence:"conservative"` (resolved OQ-MCP-1 — zero schema touch).
- **Open `payload` markers** (non-frozen), all JCS-safe:
  `mcpServer{id, transport, originOrCommandHash}` · `mcpToolPin{hash}` ·
  `mcpPinDelta{added, removed, changed}` · `mcpKeyRotation{oldSpki, newSpki}` ·
  `mcpEnvelopeSource{floor | manifest-declared}` (candidate annotation narrowing is *display-only*
  and deliberately not an envelope source) · `mcpCommandPinning{pinned | floating}` ·
  `mcpChannel{serverId, host}` on channel grants · `mcpServerLifecycle{spawn | crash | kill |
  requarantine, reason}` · `mcpNameTruncation{advertised, original}`.
- **`trust.grant`** reused for server trust; the grant mechanism reused for channel egress
  (`payload.mcpChannel`) and invocation grants.

**Reserved seam (D-1):** if the developer preview or a compliance-reporting need shows these markers
must become first-class typed fields (e.g. an `mcp.tool.execute` eventType), that is an ADR-gated
schema-version bump — documented now, not a v1 change.

### 10.2 Evidence bundle

Inside existing Appendix E files, no new format: the **pinned definitions active during the session**
(exact tool schemas/descriptions/annotations the agent operated against), per-call envelope-source
markers, channel grants, and any pin deltas/rotations. The bundle can then prove: *here is the exact
third-party tool definition in play, and here is why each call was allowed or denied* — which no
bolt-on MCP gateway offers, and which is the evidence value this integration exists to provide.

---

## 11. Phase-3 provenance: explicit dependency contract

The draft treated provenance as ambient. It is not; it is Phase 3. The honest dependency structure:

| Slice | May ship | Hard prerequisite | Why it is safe at that point |
|---|---|---|---|
| Design + ADR-0067 | now | — | settles the shape before Phase-3 memory/provenance design |
| Slice 1 (local stdio, read-first) | after developer preview; before/alongside early Phase 3 | Phase-2A warden surface (shipped) | structural bounds of §7.2 — no remote transport, empty server egress default, links not followed, POL-012-MCP live |
| Slice 2 (remote HTTP) | — | **Epic 3.1 enforced provenance + POL-011, including the §7.1 model-argument taint semantics** | argument egress to server-controlled hosts is exactly the confused-deputy surface only taint enforcement governs |
| Slice 3 (manifests + Autopilot quiet) | after Slice 2 | Slice 2 | narrowing only matters once remote exists |
| Slice 4 (client-in-warden) | any time after Slice 1 | — | pure hardening |

Two obligations flow *outward* from this doc into Phase-3 design (record in ADR-0067):

1. **Model-argument taint** must be context-conservative (§7.1) or SEC-MCP-05's guarantee is void.
2. **MCP results are just another untrusted source** in the provenance model — no MCP-special taint
   class; `fetch_result`-equivalent handling, so Phase-3 machinery needs no MCP-shaped carve-outs.

If product demand moves MCP earlier than this table, Slice 1 is the
minimum honest unit to pull forward — never Slice 2 without Epic 3.1.

---

## 12. Test program (every claim gets a test or it is deleted)

### 12.1 SEC-MCP catalog (extends §8.1; 1:1 with §3.1 / §3.2)

| ID | Attack / property | Expected | Maps to | Slice |
|---|---|---|---|---|
| SEC-MCP-01 | Configured server: any spawn/connect before `review`; any advertisement before grant | Config inert; zero process/network activity pre-review; zero advertisement pre-grant | §3.2-MCP-1 | 1 |
| SEC-MCP-01b | Malicious `.keel/mcp.json` in a freshly-trusted workspace | No execution/egress from config parse alone (the ADR-0026 collapse test) | §4.1 | 1 |
| SEC-MCP-02 | `readOnlyHint:true` on a tool that writes; policy asked to auto-allow off the hint | Enforced envelope stays at floor; hint is display-only; verdict unmoved | §3.2-MCP-2 | 1 |
| SEC-MCP-03 | Rug-pull: schema/description redefined post-grant (incl. mid-session `tools/list_changed`) | Re-quarantine; advertised set updated; audited diff; human re-grant required; never auto-accepted under any mode | §3.2-MCP-3 | 1 |
| SEC-MCP-03b | Tool shadowing: server tool named `bash` / colliding with another server; over-length name | Namespaced slug; built-ins win bare names; deterministic truncation, no collision | §3.2-MCP-10, §4.6 | 1 |
| SEC-MCP-03c | Pin-flap: server trips re-quarantine N times | Distrusted; full re-review required; surfaced reason | §4.2 | 1 |
| SEC-MCP-04 | stdio server reads `~/.ssh` / credential sources / other server's dir; writes outside workspace; fork-bombs; opens direct socket | Sandbox deny; ulimits; egress only via proxy under empty-by-default channel allowlist | §3.2-MCP-4 | 1 |
| SEC-MCP-05 | Remote host not granted; granted host but untrusted-tainted args | Pre-grant host blocked; tainted args → POL-011 review (requires Epic 3.1) | §3.2-MCP-5 | 2 |
| SEC-MCP-05b | Secret-sensitivity data (readable workspace `.env` contents; secret-tagged path) into opaque/remote MCP args | POL-012-MCP review/deny — fires without taint machinery | §3.2-MCP-5b | 1 |
| SEC-MCP-05c | Channel-scope leak: after granting server X's host, `bash`/`fetch`/server Y attempt egress to it | Blocked — grant is channel-scoped, not general allowlist | §6.2 | 2 |
| SEC-MCP-06 | Result-borne injection instructs exfiltration; `_meta`/resource-link triggers follow-on | Slice 1: link rendered inert, never followed. Slice 2+: follow-on inherits taint; egress gated; no trust upgrade | §3.2-MCP-6 | 1 / 2 |
| SEC-MCP-07 | Token passthrough: raw token in args/context/logs/audit; placeholder to wrong host | Never serialized; wrong host 403; SEC-027 corpus re-run vs MCP target | §3.2-MCP-7 | 1 |
| SEC-MCP-08 | Malformed/oversized/garbage JSON-RPC frames; hostile schemas; flood | No crash; typed errors; size caps hold; fuzz corpus in CI | §3.2-MCP-8 | 1 |
| SEC-MCP-09 | Server negotiates/attempts `sampling`/`elicitation` | Capability-not-supported; nothing reaches model or user | §3.2-MCP-9 | 1 |
| SEC-MCP-10 | Confused-deputy exfil via *granted* multi-tenant remote server | DOC-LIMIT-MCP-3 documents-the-gap + POL-011/POL-012 review evidence; closed by Phase-4 request-level egress | §3.2 limits | 2 |
| SEC-MCP-11 | Opaque MCP call presented as retry-eligible | `isRetryEligible` false for every MCP-sourced effect | §5.2.3 | 1 |
| SEC-MCP-12 | Remote identity: cross-origin redirect; MITM/origin swap; cert rotation same key; key rotation | Redirect refused; SPKI mismatch → rotation flow (defs unchanged) or re-quarantine (defs changed); rotation ≠ rug-pull UX | §4.4, §6.3 | 2 |
| SEC-MCP-13 | Localhost origin: default; DNS-rebinding hostname; missing Origin header | Denied by default; literal-loopback + Origin validation when overridden; DOC-LIMIT named on grant | §6.4 | 2 |
| SEC-MCP-14 | Server prints TUI-spoofing log lines / control bytes; unknown notification types | Server-attributed rendering, never keel's voice, never model context; bytes stripped; unknowns dropped | §7.4 | 1 |
| SEC-MCP-15 | `resources/read` / `prompts/get` requested in v1 | Typed refusal; nothing fetched or advertised | §1.2 | 1 |

DOC-LIMIT-MCP-1..6 each get a documents-the-gap test in the same suite. Architectural no-bypass tests
per §6.7. All wired into the CI `security` job.

### 12.2 Fixture corpus: `fixtures/hostile-servers/`

A versioned sibling of `fixtures/hostile-repos/` (Epic 1.7 pattern), feeding SEC-MCP-01..15 and the
demo: a poisoned-description server; a rug-puller (benign at review, redefines after grant); a
shadower (`bash`, colliding names, over-length names); a secrets-prober (reads `~/.ssh`, credential
sources, other-server dirs); a socket-opener (direct egress bypassing the proxy); a frame-fuzzer
(malformed/oversized/flood); a result-injector (exfil instructions + poisoned resource-links +
hostile `_meta`); a TUI-spoofer (keel-voiced log lines, ANSI control bytes); a capability-prober
(demands sampling/elicitation/resources); a rotation pair (same key re-cert vs new key) for
SEC-MCP-12.

### 12.3 The flagship demo, MCP variant

Extend the SEC-010 injection demo: fixture server's tool result carries an exfiltration instruction
and a poisoned resource-link; the sandbox denies the secret read; POL-012-MCP catches the readable
decoy secret headed into the opaque call; the link is inert (Slice 1) / taint-gated (Slice 2+); a
mid-session redefinition trips the pin; the audit chain shows every denied attempt. Recorded once
with the simulator and once with a real model, evidence bundle as the artifact — same discipline as
the original.

### 12.4 Performance budget

Per-call warden round-trip within the §8.3 budget: **p99 < 15 ms overhead excluding server
execution**. Pin computation, discovery, and manifest validation are grant-time only — off the hot
path. Frame-size caps enforced without buffering unbounded payloads.

---

## 13. Delivery plan (gates, not dates; TDD per §0.1 — every slice starts red)

**Now — Epic 2.25 (design/ADR, no runtime code):** land this doc + ADR-0067 (projection seam; the
four deltas MCP breaks; invariants §2; the §11 dependency contract including the model-argument
taint obligation on Phase 3; the §10.1 no-frozen-change constraint + reserved seam D-1). Exit: owner
ratification; Phase-3 design docs cite the two §11 obligations.

**Slice 1 — governed local stdio, read-first (Epic M1).** stdio only; lifecycle chokepoint (§4.1) with
review-act gating; JCS pin incl. entrypoint hash + version-pin classification; rug-pull + pin-flap;
slug/namespace/name-length; warden supervisor + per-server sandbox with empty-default channel egress;
envelope floor + `mcp_opaque` classification; POL-012-MCP; results untrusted, links inert,
size-capped; notifications rendering; capabilities refused (sampling/elicitation/resources/prompts);
secretless auth; in-kernel client with strict boundary + fuzz; `fixtures/hostile-servers/` seeded.
**Entry gate:** developer-preview feedback complete (MCP muddies the preview's feel signal —
unchanged rationale). **Exit gate:** SEC-MCP-01,01b,02,03,03b,03c,04,05b,07,08,09,11,14,15 green in
CI; DOC-LIMIT tests green; no-bypass architectural tests green; demo (Slice-1 form) recorded;
perf budget met; no frozen schema/protocol/CLI-contract change in the diff.

**Slice 2 — remote Streamable HTTP (Epic M2).** Host grant (channel-scoped) + SPKI pin + rotation
flow; redirect refusal; TLS/localhost rules; argument-egress via POL-006/POL-011/POL-012;
roots-not-sent. **Entry gate (hard):** Epic 3.1 provenance enforcement + POL-011 live, with
model-argument taint per §7.1 verified by its own Phase-3 test. **Exit gate:** SEC-MCP-05,05c,06
(enforced form),10,12,13 green; demo upgraded to the taint-gated form; confused-deputy DOC-LIMIT
evidence in bundle.

**Slice 3 — capability manifests + Autopilot quiet (Epic M3).** `.keel/mcp.capabilities.yaml`
(schema, JCS hash, pin binding); curated allowlist (≤ 12, pin-bound, version-pinned); Autopilot quiet
for manifest-declared read-only tools. **Exit gate:** manifest-detach-on-pin-change test; curated
entries verified; envelope-source markers in audit/bundle; consent-prompt count measurably reduced on
the curated set (record the number; no claim without it).

**Slice 4 — client-in-warden (Epic M4, hardening; parallelizable after Slice 1).** Move transport +
parse out of the key-holding process; pairs with the Rust warden port. **Exit gate:** SEC-MCP-08
corpus passes against the warden-side parser; kernel no longer links the MCP frame parser
(architectural test); DOC-LIMIT-MCP-4 retired.

**Slice R (reserved, unscheduled):** resources, prompts, sampling, elicitation — each per its §1.2 /
§7.5 reserved design, each its own ADR, none implied by v1.

---

## 14. Decisions (former open questions, resolved; owner may overturn at ratification)

- **D-1 (was OQ-MCP-1):** `opaque` is **not** a new composition kind in v1. Represent as
  `kind:"atomic"` + classifier `reason:"mcp_opaque"` + `confidence:"conservative"` — zero frozen
  touch. Promote only on a claim-grade compliance need, via ADR + schema-version bump (§10.1).
- **D-2 (was OQ-MCP-2):** client parse **in-kernel for Slice 1** with strict boundary + fuzz
  (§6.6); **in-warden as Slice 4**, ADR-flagged. Track the residual
  kernel-parser-on-untrusted-input risk in the linked public Slice-4 work item.
- **D-3 (was OQ-MCP-3):** opaque tools are **always-review until a manifest narrows them**. No
  per-server "I vouch" express grant exists in any slice — it is the consent-fatigue foothold, and
  §9.4 removes the legitimate demand.
- **D-4 (was OQ-MCP-4):** curated allowlist **yes** — ≤ 12 entries, each bound to a definition-pin
  hash and a version-pinned command/origin, detaching automatically on pin change (§9.4).
- **D-5 (was OQ-MCP-5):** governed MCP and the resequenced executable-extension API (Epic 1.8 →
  Phase 4 item 6) are **separate epics sharing the projection seam**. MCP is out-of-process,
  transport-mediated, and pin-governed; extensions are in-process code-loading with a different
  trust story. Sharing an epic would couple their gates; sharing the seam (both lower to
  `warden.execute`; both use the manifest-narrowing pattern) is the actual reuse, and the extension
  epic should cite §5 and §6.7 of this doc rather than re-derive them.

---

*One enforcement model. An MCP tool call is a governed tool call — warden-resolved side effect, real
verdict, sandbox, channel-scoped egress, provenance, audit — or it fails closed. A server is a
governed process or a governed endpoint — never trusted infrastructure. A definition is pinned data —
never authority. If a future requirement seems to need a second policy path, a `warden.execute`
bypass, or a "trust the server" flag, it is mis-scoped; re-read §2.*
