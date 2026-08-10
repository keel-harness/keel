# ADR-0091 — Human-authorized Git push and pull-request publication

- **Status:** **Accepted.** The keel maintainer accepted the five authority decisions in public issue
  [#191](https://github.com/keel-harness/keel/issues/191) on 2026-08-10 and authorized this contract
  slice, followed by the red-first walking skeleton only after this ADR merges and exact post-merge
  `main` CI is green.
- **Date:** 2026-08-10.
- **Decider:** keel maintainer.
- **Governs:** an exact-once typed `git.push` capability and the later, separately approved
  GitHub-specific pull-request creation capability. Relates to MASTER_SPEC §1.1, §3.2, §3.3, §4.2,
  §4.3, §4.8, §4.9, Appendix A, Appendix B, Appendix D, POL-005/006/007, and SEC-022; ADR-0017,
  ADR-0024, ADR-0028, ADR-0033, ADR-0038, ADR-0039, ADR-0056, ADR-0066, ADR-0075, ADR-0076,
  ADR-0080, ADR-0081, ADR-0084, ADR-0086, ADR-0088, ADR-0089, and ADR-0090.
- **Implementation plan:** [Issue #191](https://github.com/keel-harness/keel/issues/191).

## Acceptance and issue alignment

Keel currently prepares, verifies, and commits local changes, but remote Git and pull-request
publication remain terminal external-write boundaries. That truth is documented in PR #190. It is
correct for arbitrary `bash` and `process.run` requests, but it leaves a table-stakes coding-agent
workflow incomplete: after a human has inspected an exact commit and deliberately approves its
publication, Keel still cannot perform the push through its governed product path.

On 2026-08-10, the maintainer accepted issue #191's five proposed decisions:

1. use a typed `git.push` authority instead of broadening arbitrary command review;
2. begin with one canonical HTTPS transport through the enforcing SRT boundary;
3. permit one branch creation or ordinary fast-forward update only, with exact-once consent;
4. keep Git credentials in the Warden and host-side SRT credential path, never the model or child;
   and
5. prove Git push first, then add a separate GitHub REST pull-request mutation.

Acceptance authorizes this ADR/contract slice and the issue's red walking skeleton after the ADR
merge gate. It does not authorize later hardening slices, pull-request implementation, package or
release publication, force push, deletion, tags, default-branch mutation, a security-claim promotion,
or a frozen protocol/audit change.

## Context

The existing behavior is intentionally terminal. A Git push is a process execution, a network
write, and an external-service mutation. Generic command-review eligibility rejects those effects;
ADR-0090's `process.run` review accepts only the sole same-session mutable-metadata cause and
explicitly excludes egress and external writes. A domain grant is also too broad: authorizing a
multi-tenant host such as `github.com` does not identify the repository, source commit, destination
ref, or mutation posture.

Git itself supplies useful safety primitives, but ordinary workspace `git push origin branch` is not
an exact authority boundary. Git accepts explicit source-to-destination refspecs and, without force,
allows a branch only to be created or fast-forwarded. It can also obtain behavior from repository,
global, and system config: `pushurl`, multiple push URLs, URL rewrites, default refspecs, hooks,
credential helpers, proxies, redirects, TLS options, submodule recursion, custom receive-pack
programs, alternates, and environment variables. The Warden must resolve and neutralize those
surfaces; displaying model argv does not make them safe.

Credential custody is equally important. Git normally asks a credential helper, askpass program, or
terminal for HTTPS credentials. Giving those facilities to the sandboxed Git process would place the
real secret inside the governed child. ADR-0066 already proves parent-side secret resolution and
verified-TLS host-side Authorization injection through vendored SRT. ADR-0086 adds a Warden-owned
connect-time destination-address guard to that backend. The new capability should reuse those
enforcement boundaries, not create a host-side network escape.

## Decision criteria

An acceptable design must:

- bind the human decision to one trusted workspace, repository, canonical HTTPS URL, destination
  branch, and full commit object ID;
- allow only one branch creation or ordinary fast-forward update to the approved commit;
- keep raw `bash` and `process.run git push` terminal and preserve POL-005/006/007;
- make the Warden the sole resolver, review issuer, approval consumer, revalidator, executor,
  credential custodian, audit writer, and completion verifier;
- place no credential byte in model context, child argv/env/config, RPC, session, transcript, audit,
  evidence bundle, screenshot, fixture, or error text;
- run the network operation only through verified-TLS `srt:vendored` with the connect-time address
  guard active and ordinary certificate/SNI verification intact;
- prevent repository config, redirects, hooks, helpers, refspec defaults, submodules, or environment
  from widening the reviewed target;
- consume approval before credential lookup, network access, or child launch and reject every material
  drift before side effects;
- durably record intent before the first network operation and never automatically retry a mutation;
- distinguish confirmed success, confirmed no-op, failure, and indeterminate completion using
  Warden-observed remote state rather than model self-report;
- remain usable at 100×30 with a complete, lossless, Warden-authored approval basis; and
- preserve frozen protocol 1.1 and Appendix-B/D shapes if their existing generic/open seams suffice.

## Decision

### 1. Publication is a typed capability, not a command exception

Add a model-facing tool named `git.push` and advertise it only when the spawned Warden advertises
`git-push/v1` and the workspace is trusted. `bash` and `process.run` requests containing Git push
remain on their current policy path and receive no authority from this ADR. When `git.push` is
available, their terminal recovery guidance may point to a fresh typed request; Keel never rewrites,
converts, or retries the original command.

`git-push/v1` is backend- and evidence-specific. The Warden advertises it only when all of these are
active:

- an enforcing `srt:vendored` sandbox;
- verified HTTPS termination suitable for ADR-0066 host-side credential injection;
- ADR-0086 `egress-address-guard/v1` connect-time resolution and address pinning;
- a Warden-owned declared temporary root;
- durable intent/outcome audit;
- an identified absolute Git executable supported by the compatibility matrix; and
- the typed Git-push resolver, review store, credential broker, and executor.

The kernel additionally withholds the tool until workspace trust. A fake/non-SRT sandbox, disabled
TLS verification, missing address guard, unavailable audit, unsupported platform/Git, or incomplete
component cannot advertise the capability. Capability presence does not promise that credentials or
the requested repository are valid; those are occurrence-specific checks.

No new RPC method is needed. The generic strict `warden.execute` request already carries a tool name
and JSON args; the existing `ReviewRequired` and `warden.resolveReview` shapes carry one pending
review and `scope:"once"`; `ExecuteResult.result` and Appendix-B open payloads carry bounded result
facts. No new grant scope, `PolicyInput`, `SideEffect`, `AuditRecord`, session, or evidence-bundle
field is introduced.

Slice 1 may install a deterministic credential provider only in the test fixture to prove the
spawned-Warden → real-Git → SRT/TLS path before the operator Git-helper broker is complete. That
provider is not selected by CLI input, environment, RPC, workspace/project config, or the release
Warden; its secret enters only Warden memory from fixture-owned authority and follows the same
host-side injection and non-disclosure rules. A production/release Warden continues to withhold
`git-push/v1` until the operator-helper broker and all other production prerequisites above exist.
If the test-only provider cannot be excluded mechanically from the release route and exact carrier,
the walking skeleton stops rather than advertising an incomplete capability.

The same non-release fixture boundary may bind one Warden-test-owned `localhost` HTTPS URL to one
ephemeral non-default port selected by the test server. This authority is an injected test component,
not a parser option: CLI input, environment, RPC, Git/project config, and release code cannot enable
it or choose its host/port. The fixture still uses verified TLS/SNI, host-side credential injection,
the real SRT proxy, and an ADR-0086 address-guard exception bound to that exact loopback occurrence.
The approval card displays the actual port losslessly. Production parsing remains implicit port 443
only, and fixture evidence cannot prove the production default-port/provider path. If exact-carrier
inspection can reach this exception, or a fixture request can select any other host/port, stop.

If implementation needs controller inference from prose for authority, a new RPC method/field, a new
grant scope, or a non-open durable schema change, this ADR is insufficient. Stop for a protocol
version, compatibility analysis, and separate ADR.

### 2. V1 request is minimal and exact

The model-facing arguments are exactly:

```json
{
  "remote": "origin",
  "branch": "feature/example",
  "expectedHead": "0123456789abcdef0123456789abcdef01234567"
}
```

The authoritative Warden parser, independently of the model-facing JSON Schema, enforces:

- `remote`: an explicit 1–64 byte ASCII remote name matching
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`;
- `branch`: an explicit 1–128 byte ASCII short branch name, accepted by `git check-ref-format
  --branch`, neither `HEAD` nor `@`, and not beginning with `refs/`, from which the Warden constructs
  exactly `refs/heads/<branch>`;
- `expectedHead`: a full lowercase hexadecimal object ID, exactly 40 ASCII characters for a SHA-1
  repository or 64 for SHA-256, whose object is a commit and whose value equals current `HEAD`; and
- strict object keys with no defaults or additional fields.

The caller cannot supply a URL, ref namespace, revision expression, abbreviated OID, force/delete
posture, tag, multiple ref, upstream setting, push option, receive-pack, recursion, credential,
environment, cwd, stdin, retry, or background option. `HEAD`, a branch shorthand as source, an empty
source, a leading `+`, and any `refs/*` destination are invalid model inputs.

Invalid arguments are audited pre-execution denials and become ordinary failed tool results with one
exact correction. They never create a pending review, resolve a credential, open a socket, or launch
Git. This follows issue #157's accepted invalid-parameter recovery rule without weakening policy.

The public result semantics are:

- `pushed`: independent observation confirms the exact destination ref equals the approved commit
  after Git reported an admitted push attempt;
- `already-at-commit`: the approved read-before-write observation found the exact ref already at the
  approved commit, so no push child was launched;
- `failed`: the branch is confirmed not to equal the approved commit and the Warden has a definitive
  failure; object negotiation or upload may still have occurred and must not be described as zero
  remote effect; and
- `indeterminate`: the push may have executed but exact final ref state could not be established.

Every status includes a bounded credential-free repository identity, destination branch, full commit
OID, and audit sequence. Confirmed statuses include the Warden-observed ref OID. Exact JSON
presentation remains an internal convention behind the existing `ToolResult` string port in V1; the
four semantic states and retry meanings are the stable product contract.

### 3. The Warden resolves local facts before review, without network access

Before minting a review, the Warden establishes all local facts through bounded, direct-argv,
network-denied probes after workspace trust:

1. The canonical workspace contains an ordinary, non-bare Git repository whose `.git` is a real
   directory inside that workspace. V1 rejects linked worktrees, submodule repositories, bare repos,
   symlinked/out-of-workspace Git dirs, shallow or partial clones, replacement/graft state, object
   alternates, and unusual layouts.
2. Repository object format is recognized; current `HEAD` equals `expectedHead`; the object is a
   commit; and the Warden derives a bounded subject, author timestamp, parent count, and committed
   file/addition/deletion summary. Control-bearing or non-losslessly displayable metadata makes the
   occurrence terminal.
3. With includes disabled, local repository config contains exactly one `remote.<name>.url`, no
   `pushurl`, mirror, or extra URL. System/global/project includes cannot supply the publication URL.
4. The URL is canonical HTTPS with ASCII host, default port, bounded canonical path, and no userinfo,
   password, query, fragment, IP literal, non-default port, or helper/alternate transport syntax.
5. The exact destination is one `refs/heads/*` ref. Dirty staged, tracked, and untracked worktree
   state is summarized as **excluded from the commit**; it neither changes the approved object nor
   silently becomes publication data.

Local read-only Git probes run inside containment with network denied, hooks and helpers inert,
bounded output/time/resources, and no write outside a Warden-declared temp root. The Warden never
trusts model-provided repository, URL, commit, branch-safety, or summary facts.

For V1, canonical URL means exactly `https://<dns-host>/<path>`: lowercase DNS host without a
trailing dot, implicit port 443, and a 1–384 byte ASCII path made of nonempty `/`-separated segments
whose bytes are `[A-Za-z0-9._~-]`. `.` and `..` segments, duplicate/trailing separators, percent
escapes, backslashes, and URL-normalization drift are rejected rather than rewritten. The complete
serialized URL is at most 512 bytes. The Warden passes and displays those identical bytes. This
intentionally narrow grammar covers the initial GitHub HTTPS form. Slice 1's mechanically
non-release loopback-port authority is the sole exception described in §1; broader product/provider
URL syntax needs a later contract amendment and evidence.

### 4. Review is exact, once-only, and losslessly presented

An eligible occurrence creates an internal `PendingGitPushReview` with ID
`git_push_review_<positive integer>`, a Warden-monotonic 120,000 ms TTL, and only:

```text
keel approve <review-id> --scope once
```

Session, project, Plan, Autopilot, persisted, wildcard, host, repository, branch-family, and replayed
grants cannot resolve it. Guided interactive input may submit `Approve once` or `Deny`; explain is
presentation-only. One-shot/headless/no-handler paths settle denial without execution and tell the
human to rerun the exact request in an interactive governed session. YOLO supplies no authority.

The request binding is a versioned canonical hash over at least:

- original strict tool name/args and exact full OID;
- canonical workspace and Git-dir identity, repository/object-format facts, and local metadata
  observations used for the card;
- remote name plus the exact local-config bytes/provenance used to derive the normalized URL;
- normalized credential-free URL, ASCII host, default port, repository path, and destination ref;
- Git executable absolute path plus stable file identity;
- policy pack identity, policy decision, complete dynamic `SideEffect`, and provenance context;
- complete sandbox profile, active SRT/TLS/address-guard features and revision, deny roots, and
  Warden temporary authority;
- credential-broker executable/config identity without helper output or secret bytes;
- audit availability, session ID, review ID, creation/expiry, and any Warden-owned generation needed
  to invalidate sibling state.

Principal arrives only on `warden.resolveReview` and forms a second approval binding, following
ADR-0090. The asserted local principal, exact request key, `scope:"once"`, and resolution time are
durably recorded before revalidation. This does not claim a new authentication mechanism.

The Warden summary uses this exact line order and fixed labels; angle-bracketed phrases below are
metavariables, not literal delimiters:

```text
Git push requires approval.
Repository: <canonical credential-free HTTPS URL>
Destination: <exact refs/heads/* ref>
Commit: <full object ID>
Subject: <lossless bounded subject>
Commit facts: <author timestamp>; <parent count>; <file count> files; +<additions> -<deletions>
Workspace: <clean | has uncommitted changes>; uncommitted changes are excluded
Effect: create this branch or fast-forward it to this commit; the remote may receive every missing object reachable from the commit
Blocked: force, deletion, tags, hooks, submodule recursion, redirects, and remote-default-branch writes
Credential: <credential source class>; secret stays in the Warden/SRT path
Approval: this occurrence once; expires in 120 seconds
```

Values cannot contain a line break, C0/C1 control, bidirectional-control, unpaired surrogate, or
non-lossless replacement. Literal backslash, semicolon, and angle-bracket characters in values remain
literal because line labels and line endings, not punctuation inside a value, delimit fields. The
summary is display-only: controller and policy code never parse values or authority from it.

The template states, completely and without truncation, redaction, or control normalization:

- exact credential-free repository URL and `refs/heads/*` destination;
- exact full commit OID and bounded subject;
- create-or-fast-forward-only behavior;
- that Git may send all objects reachable from the commit that the remote lacks, not only a displayed
  diff;
- that uncommitted workspace changes are excluded;
- that force, deletion, tags, hooks, submodule recursion, redirects, and remote-default-branch writes
  remain blocked;
- credential source class, never credential value; and
- approval applies to this one occurrence only.

The only source-class values are `operator Git credential helper (system/global config)` in the
production design and `deterministic test fixture (release capability withheld)` in Slice 1's
non-release fixture. A fixture-backed card cannot be reused as production evidence.

The canonical URL is at most 512 UTF-8 bytes, the subject at most 160 UTF-8 bytes, and decimal count
fields at most 20 digits. Together with the request limits in §2, the complete summary is capped at
2,048 UTF-8 bytes, 2,048 Unicode terminal cells under the shared deterministic width implementation,
and 20 wrapped content rows at 96 columns. These are conjunctive limits, not truncation targets. They
leave the 100×30 approval surface room for status, choices, and failure guidance; if any limit cannot
be met losslessly, the review stays terminal. The controller adds a `git.push`-specific lossless lane
like ADR-0090's `process.run` lane. It selects only by retained tool name plus strict review-ID and
once-only `allowCommand` checks, never by parsing summary prose. Every controller/ViewModel/Ink
boundary proves exact bytes. Any mismatch, normalization, redaction, abbreviation, omission, or
truncation makes the card non-actionable and settles denial.

### 5. Credential custody stays parent-side and operator-owned

After approval is consumed and immediately before network access, the Warden runs Git's credential
plumbing parent-side for the exact canonical HTTPS context. The broker:

- runs outside the workspace with no repository-local config and accepts only operator-owned
  system/global credential-helper configuration;
- disables terminal and askpass prompting, bounds stdin/stdout/stderr, time, helpers, and concurrent
  resolution, and fails closed on interactive, missing, partial, duplicate, malformed, oversized,
  expired, or context-mismatched output;
- passes no secret in argv and accepts exactly one matching protocol/host/path username/password
  result under a versioned parser;
- may execute an operator-configured helper or shell snippet because the same OS user and operator
  config are trusted in V1, but binds its public identity into the review and never accepts helper
  authority from the project;
- never invokes credential `approve`, `store`, `reject`, or `erase`; and
- keeps username/password/token only in Warden memory long enough to construct the HTTPS Basic
  authorization value.

The real authorization value is supplied only to ADR-0066 SRT swap-on-access for the exact host over
verified TLS. The sandbox child receives no real or placeholder credential, credential helper,
askpass program, URL userinfo, username/password, or terminal prompt. Its Git config explicitly
resets credential helpers. Plaintext credential injection and disabled certificate verification are
not test or product fallbacks.

Project `.git/config`, `.keel` config, workspace files, environment named by the model, and model
prose cannot choose a helper or Warden secret source. `keel doctor` may inspect Git/helper
availability without resolving or printing a credential and gives one copy-paste GitHub HTTPS setup
path. Doctor never calls a token-printing command.

### 6. Approval consumes first; execution revalidates and stays config-independent

A schema-valid resolution naming a live review consumes it before any approval work. Denial, wrong
or omitted scope, expiry, cancellation, revalidation failure, audit failure, credential failure,
sandbox loss, Git failure, or verification failure leaves no reusable authority.

For approval, the Warden:

1. validates exact-once scope, expiry, principal, and approval binding and durably records resolution;
2. rebuilds every local, policy, sandbox, transport, Git, config, URL/ref, audit, temp-root, and
   credential-broker identity fact and rejects any binding drift before network access;
3. consumes/stales sibling publication authority as defined by the implementation's Warden-owned
   generation;
4. durably writes pre-execution intent before credential lookup or the first socket;
5. resolves the credential parent-side;
6. performs a credentialed, redirect-disabled `ls-remote --symref` through the same SRT boundary;
7. returns `already-at-commit` without launching push if the ref already equals the approved commit,
   and denies without mutation if the destination is the observed remote default branch;
8. prepares an owner-only bare repository in the Warden-declared temp root with the same object
   format, no inherited config or refs, and read-only access only to the revalidated workspace object
   store;
9. launches one direct Git process with the exact normalized HTTPS URL and exact
   `<full-oid>:refs/heads/<branch>` refspec, ordinary no-force semantics, `--no-verify`,
   `--recurse-submodules=no`, bounded porcelain output, redirects disabled, ordinary TLS
   verification, and all non-SRT proxy/config/helper/hook/trace/editor/pager authority removed; and
10. independently observes the exact destination ref, records a bounded outcome, and returns one of
    the four product states.

The temp repository prevents workspace `pushurl`, URL rewrite, refspec, helper, hook, proxy, TLS,
receive-pack, and recursion config from affecting the launched push. V1's object handoff uses the
workspace object database only as revalidated read-only immutable input; alternate-object metadata is
rejected, the sandbox grants no workspace write to this tool, and the temp repository contains no
workspace refs/config. The red walking skeleton must prove that real Git can resolve the approved OID
through this handoff and that no repository-controlled execution or path expansion survives. If it
cannot, stop for an ADR amendment; do not fall back to pushing from the workspace.

The human approves a final state, not a stale remote tip: create or move this one branch to exactly
the approved commit without force. Git's ordinary branch rule permits creation or a fast-forward of
the then-current tip and rejects non-fast-forward races. The Warden never supplies `--force`, a
leading `+`, `--force-with-lease`, deletion, or multiple refspecs. Server-side rules remain an
independent backstop.

The remote-default check does not claim universal protected-branch discovery. Provider-specific
rules may protect other branches; their rejection is reported. Supporting an explicit default-branch
push or provider protection query is a later authority decision.

### 7. Completion and retry truth are Warden-observed

After an admitted push attempt, an independent credentialed exact-ref observation uses the same
canonical URL, SRT TLS path, address guard, and no-redirect posture:

- exact observed ref equals the approved commit: `pushed`;
- the approved preflight already found that exact state: `already-at-commit`;
- the Warden definitively observes a different/absent ref together with a definitive rejection or
  local failure: `failed`; and
- successful mutation cannot be confirmed or excluded, including lost response, Warden/transport
  failure, observation failure, or a concurrent later remote update: `indeterminate`.

`failed` does not promise zero transferred objects. `pushed` proves the observation time, not that
another actor cannot move the ref afterward. `indeterminate` says the action may have executed, never
renders complete, and requires restart/audit/remote inspection before deliberate recovery.

Keel performs no automatic retry of credential lookup, push, pull-request creation, or indeterminate
reconciliation. Protocol-required HTTP exchanges inside one Git process are not Keel retries. A
fresh typed request starts with current facts and needs a fresh human approval; if the ref already
equals the requested commit it can safely return `already-at-commit`.

Audit uses existing event types and open payloads. It records original args, resolved
credential-free identity, request/approval binding keys, principal/TTL/scope, policy and dynamic
effect, intent, Git child outcome, and remote verification state/OID. It never records helper output,
username, password/token, Authorization value, credential-bearing URL, or raw secret-adjacent errors.

### 8. Pull-request creation is a separate later capability

After the Git-push walking skeleton and hardening gates pass, a later explicitly authorized slice may
add `github.pr.create` with a distinct `github-pr-create/v1` capability. It is not part of the
`git.push` approval and never executes implicitly after a successful push.

Its initial provider contract is GitHub REST over the same Warden/SRT verified-TLS/address-guard
boundary, with host-side Bearer injection and no `gh` subprocess or model-visible token. The exact
request binds canonical repository, already-verified head branch and full head OID, existing base
branch, bounded title/body, `draft`, and `maintainerCanModify`. The Warden must show the entire escaped
title/body losslessly; content that exceeds the existing 2,048-cell approval surface is not
approvable in V1.

PR creation gets a separate exact-once review, durable intent, no automatic retry, and an independent
result check that the returned PR belongs to the exact repository/head/base and reports the expected
head OID. A response-loss ambiguity is reconciled only through a bounded exact read; otherwise it is
indeterminate because the endpoint triggers notifications and duplicate creation is consequential.

No merge, auto-merge, review, label, issue mutation, release, deployment, or default-branch update is
authorized. GitHub Enterprise, GitLab, Bitbucket, Gitea, and other forges require later provider ports
and explicit evidence; a generic forge abstraction is not built before the first stable seam exists.

### 9. Claims remain narrow until evidence passes

This accepted ADR is not implementation evidence. Until every required gate passes, README, status,
reference, and the claim ledger continue to say remote publication is terminal. When implementation
does pass, wording is limited to the exact interactive trusted-workspace HTTPS
`srt:vendored`/supported-Git surface that was tested.

This decision adds no generic egress, provenance-taint, provider-egress, request-body inspection,
allowlisted-host isolation, protected-branch discovery, credential-store, cross-platform, or
all-tool claim. SEC-022 remains bounded by exact Warden URL/ref/commit resolution and the fixed Git
process, not by route-level SRT inspection; multi-tenant-host and compromised-Git residuals remain
explicit. Phase-3 provenance enforcement is neither pulled forward nor implied. Because every V1
push requires exact human once-only review, no unknown/untrusted provenance receives automatic
egress authority.

## Options considered

### Option 1 — typed `git.push` over existing generic RPC

**Selected.** It gives the Warden a small structured request, exact repository/ref/commit resolution,
and a dedicated once-only lifecycle without weakening arbitrary command or egress policy.

### Option 2 — make `process.run git push` actionable

**Rejected.** Exact argv does not neutralize Git config, helpers, hooks, refspec defaults, credentials,
or repository identity, and generic process review would broaden materially different network-write
authority.

### Option 3 — grant the Git host/domain, then run ordinary push

**Rejected.** A multi-tenant host grant identifies neither repository nor ref nor commit and reopens
SEC-022. Domain authority is not repository mutation authority.

### Option 4 — run Git directly in the Warden host without SRT

**Rejected.** It bypasses the OS/network enforcement and address guard that the capability claims.
The Warden is authority, not an unsandboxed network escape hatch.

### Option 5 — pass a token/helper into the sandboxed Git child

**Rejected.** Redaction is not an enforcement boundary. A child that receives a token can expose it
through output, process state, config, helpers, or another allowed request.

### Option 6 — SSH first

**Deferred.** SSH key/agent custody, host-key policy, config includes, ProxyCommand, Match blocks,
agent forwarding, and known-host identity need a distinct threat model. HTTPS reuses current proven
credential/TLS seams.

### Option 7 — combine push and PR creation in one approval

**Rejected.** They mutate different resources, have different credentials/APIs, and fail
independently. Separate consent and evidence keep recovery honest.

### Option 8 — allow force-with-lease as “safe force”

**Rejected.** It still permits non-fast-forward history replacement and widens the human decision.
V1 publishes only creation or ordinary fast-forward.

## Consequences and residual risk

- Keel can eventually complete the normal commit → approved feature-branch push workflow without
  asking users to bypass the harness.
- Users approve the exact desired final branch/commit state, while Warden and Git reject history-loss
  races.
- The first version is intentionally narrower than ambient Git: HTTPS only, one ordinary repository,
  ASCII branch names, no linked worktrees/partial clones/LFS/submodule recursion, no default branch,
  and supported Git/SRT platforms only.
- Operator credential helpers execute with same-user host authority. A malicious same-user helper or
  compromised Git executable is outside V1's kernel/OS-user threat boundary; identity drift still
  invalidates pending approval.
- A hostile remote or Git vulnerability can affect the sandboxed Git client. Resource limits,
  workspace read-only exposure, secret denial, exact egress, SRT address checks, TLS verification,
  and no hooks/helpers bound but do not eliminate that risk.
- Host/IDE/same-user races outside the Warden remain residual. Revalidation closes Warden-observed
  drift; it does not claim kernel-level immutable snapshots of the workspace object database.
- Server rejection may still receive and retain unreachable Git objects. `failed` therefore describes
  the branch result, not absence of all remote bytes.
- Default-branch detection depends on the remote's advertised `HEAD`; other protected branches remain
  provider/server concerns.
- The SRT credential mutator is host-bound rather than route-inspecting. Exact URL/ref/commit and a
  config-independent Git process sharply narrow the request, but this is not a generic per-route
  egress claim.
- A pull-request body larger than the lossless approval budget remains unsupported until a versioned
  structured review artifact is designed.

## Required implementation evidence

Issue #191 remains the public work order. Every behavior slice is red-first. Before the Git-push
walking skeleton can merge, evidence must prove at least:

1. capability withholding unless trusted product routing, durable audit, Warden temp authority,
   `srt:vendored`, verified TLS injection, address guard, supported Git, and the typed implementation
   are all active;
2. exact strict-args parsing for remote/branch/full OID and failure before review, credential, socket,
   or child for every invalid class;
3. an ordinary repository resolves one exact local URL/ref/commit and every alternate layout,
   pushurl/multi-URL/mirror/transport/userinfo/query/fragment/port/redirect/config widening case
   remains terminal;
4. a real authenticated smart-HTTPS Git server receives one exact feature-branch creation through
   real Git/libcurl, SRT verified TLS, and the Warden address guard, with ordinary certificate/SNI
   checks and no plaintext or host-side bypass;
5. no pre-push hook, helper, askpass, submodule recursion, URL rewrite, proxy, receive-pack, refspec
   default, replace ref, alternate, or repository config executes or changes the target;
6. the human sees complete Warden-owned repository/ref/full-OID/consequence/credential-class facts;
   any mutated, redacted, truncated, normalized, stale, or forged presentation settles denial;
7. deny, headless/no-handler, timeout, cancellation, disconnect, duplicate/stale ID, project/session
   scope, Warden loss, audit failure, sandbox drift, Git identity drift, config/HEAD/object/temp-root/
   credential-broker drift, and secret-scan incompleteness cause zero network and child execution;
8. approval is consumed before credential/network work, intent is durable before the first network
   operation, and failure/indeterminate outcomes never retry automatically;
9. canary username/token/Basic bytes are absent from child argv/env/config, descriptors, process
   listings, stdout/stderr, model output, controller/TUI/headless/resume/receipt state, session JSONL,
   audit, evidence bundle, snapshots, screenshots, fixtures, and repository;
10. `already-at-commit`, new-branch `pushed`, subsequent fast-forward `pushed`, non-fast-forward
    rejection, remote-default denial, server rejection, lost response, verification mismatch, and
    verification failure produce the exact completion truth, while unrelated refs remain unchanged;
11. property mutation of every bound fact invalidates review or approval, and parser/fuzzer suites
    cover URLs, refs, config output, credential protocol, binding canonicalization, and summary
    losslessness; and
12. focused tests, coverage, security suite, real macOS/Linux sandbox, egress product, Node 20/22/24,
    exact npm carrier, exact-head CI, post-main CI, and independent spec/security, reliability, DX,
    and simplicity reviews pass before any claim changes.

The first red walking skeleton specifically proves that current main cannot open/resolve `git.push`
or carry real Git through the verified-TLS credential path. It then makes only one exact new
feature-branch publication pass end to end. Later issue slices harden the complete matrix; a green
walking skeleton alone does not complete this ADR or authorize claim promotion.

## Stop conditions

Stop rather than implement if:

- exact URL/ref/commit authority must be inferred from model prose or generic command argv;
- Git must run from workspace config, outside `srt:vendored`, without the address guard, over
  plaintext, or with TLS verification disabled;
- a real credential must enter child/model/kernel-visible or durable carriers;
- approval cannot be exact-once, consumed first, fully revalidated, or losslessly presented;
- force, deletion, tags, multiple refs, remote default branch, SSH, project helpers, or reusable
  grants become necessary for the walking skeleton;
- durable intent cannot precede the first network operation or indeterminate mutation can retry;
- the object handoff cannot exclude repository-controlled execution/config widening;
- an additional dependency is proposed without separate necessity/license/supply-chain review;
- a frozen RPC/audit/policy/taxonomy/grant/session/evidence contract must change without a versioned
  ADR; or
- implementation or documentation would imply provenance, generic egress, provider, protected-branch,
  platform, or credential-security claims not established by executable evidence.
