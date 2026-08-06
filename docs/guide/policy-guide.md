# Policy and approval guide

keel's safety model is structural: the model requests work, and the out-of-process warden decides
what runs. Nothing you see in the TUI — a status panel, a receipt, or a model answer — can change
policy.

Read this when you need to know what the footer, `/policies`, live review prompts, Autopilot, and
YOLO actually mean.

## What `/policies` shows

`/policies` is a read-only inspection panel. It reports only what the runtime has already told the
TUI:

- the active policy label, if status carried one;
- sandbox and network posture, plus the audit evidence state;
- the live or last-known review count, when available.

Anything keel cannot currently prove is omitted or marked unavailable. It is never inferred.

`/policies` cannot edit policy, approve a review, trust a workspace, or change Autopilot mode. It
never shows stronger enforcement than the footer. **If `/policies` and the footer disagree, treat it
as a bug and trust the weaker reading** until it is investigated.

Two labels are easy to over-read:

| Label | What it actually means |
| --- | --- |
| `egress on` | The active warden advertised `egress-address-guard/v1` after its SRT proxy, resolver, classifier, exception snapshot, and audit sink all started. A domain allowlist alone does not earn this label, and a backend that does not advertise the capability reports a weaker state. |
| `audit unseen` | Warden protections are active, but keel has not yet observed a non-empty audit head. It is a statement about evidence, not queued work, and not a promise that a write will happen. `audit on` appears only once evidence is observed in the chain. |

## Where policy is configured

The warden owns runtime policy evaluation. The built-in starter pack is
`phase2a-starter-policy-pack`, and it is the default for the current governed runtime.

The mode and grant choices you can set today live in keel-owned user configuration, never in project
files:

```sh
keel autopilot mode status
keel autopilot mode set guided | autopilot | project-autopilot
keel autopilot mode clear
keel autopilot grants list
keel autopilot grants revoke --domain <domain>
keel autopilot grants revoke --command-key <sha256:key>
```

A project cannot raise its own autonomy, mark itself trusted, or approve its own reviews. A
workspace must be trusted before any non-Guided mode takes effect, and a running session does not
silently change when you edit config.

Policy-pack authoring, loading an alternate pack, and organization-wide policy distribution do not
exist yet. Until they do, the footer and `/policies` are status displays, not policy editors.

## Mode labels

| Mode | What it means |
| --- | --- |
| `Guided` *(default)* | keel works under warden policy and may ask before risky, broad, external, destructive, or provenance-sensitive actions. Denials still deny. |
| `Autopilot` | High autonomy inside enforced boundaries. It reduces prompts for actions the warden can already prove are contained and low-risk. It does not relax sandboxing, turn a deny into an allow, trust project files, or consult model confidence. |
| `Project Autopilot` | Autopilot plus persisted project-scope grants, for trusted projects only. It shows the exact authority granted; list and revoke with `keel autopilot grants`. |
| `YOLO` | The design term for reduced or absent enforcement. **keel does not expose a YOLO switch.** Attempts to reach one are rejected rather than silently weakening protection. |

If a future YOLO surface is ever built, the spec requires it to be explicit, persistent, audited
where possible, never the default, never a security claim, and visibly different from Autopilot.

Stricter-sounding labels such as "locked down" are policy or profile labels. They mean something
only when the warden's runtime status carries them. A name alone never implies a stricter mode.

## Live review decisions

A review is actionable only while the warden holds it open. keel shows a focused
`approval required` prompt and pauses until you choose:

| Key | Command | Effect |
| --- | --- | --- |
| `a` | `/approve once` | Allow only the current pending action. |
| `s` | `/approve session` | Allow the exact domain or command envelope for this session only. Offered only when the review carries an exact resource. |
| `d` | `/deny` | The action does not run. |
| `?` | `/why` | Explain the decision before you make it. |

`/reviews` is read-only. It is useful for seeing what happened, but **stale receipts are not
buttons** — once a turn has ended, an old review line cannot be approved from the transcript.

## Once, session, and project scope

| Scope | Reach |
| --- | --- |
| Once | Releases only the current pending review. Remembers nothing. |
| Session | The exact domain or command envelope from that review, until the session exits. Not a glob, not a directory grant, not project-wide trust. |
| Project | Persisted only through the explicit Project Autopilot grant path. Names the exact stored authority and stays revocable. |

There is no generic "approve and remember" button. Project scope is never granted from a live
review.

## Address exceptions are not grants

A hostname grant answers whether a domain may be contacted. A private-address exception answers a
different question: whether one exact hostname and port, for one resolved workspace, may use an
address inside one restricted CIDR. **Both must match** before the SRT connect-time guard allows the
connection.

Only a human manages exceptions, through `keel egress exception add|list|remove`. They live in
keel-owned user configuration, not the project, and they cannot cover loopback, metadata, or other
hard-denied destinations. A running warden keeps its startup snapshot, so changing an exception does
not widen a live session — restart it to activate the new revision. Syntax and storage are in the
[reference](reference.md#egress-address-exceptions).

## Admin checklist

1. `keel autopilot mode status` — the configured mode, and whether the workspace is trusted.
2. `keel autopilot grants list` — persisted project grants.
3. `keel egress exception list --workspace <path>` — private-address authority, which is separate.
4. `/policies` in the TUI — what the live session actually knows.
5. `/reviews` — audit review receipts, but do not treat it as an approval surface.

Prefer Guided for unfamiliar or sensitive repos. Use Autopilot only where you understand the warden
status, the trust state, and the grant scope.

---

This guide documents existing surfaces. It does not add a policy engine, an approval authority, a
sandbox claim, an audit guarantee, a policy-pack selector, or an admin console.
