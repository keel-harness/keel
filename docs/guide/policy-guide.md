# Policy and approval guide

Keel's safety model is structural: the model requests work, and the out-of-process warden decides what runs. The TUI should make that visible without implying that a status panel, receipt, or model answer can change policy.

Use this guide when you need to understand what the footer, `/policies`, live review prompts, Autopilot, and YOLO mean.

## What `/policies` shows

`/policies` is a read-only inspection panel. It reports only the protection facts the TUI has already received from the runtime:

- active policy label, if one was carried by status;
- sandbox and network on/off posture, plus audit on/unseen/off evidence state;
- live or last-known review count, when available;
- fields the TUI cannot currently prove are omitted or explicitly marked unavailable; they are never inferred.

It does not edit policy, approve a review, trust a workspace, change Autopilot mode, or prove stronger enforcement than the footer already shows. If `/policies` and the footer disagree, treat that as a bug and trust the weaker reading until it is investigated.

`egress on` means the active warden advertised `egress-address-guard/v1` after the SRT proxy,
resolver, classifier, exception snapshot, and audit sink initialized. A domain allowlist by itself is
not enough for that label. A backend that does not advertise the capability must report the weaker
state.

`audit unseen` means warden protections are active but the TUI has not observed a non-empty audit head. It is an evidence statement, not queued work or a promise that a write will occur. `audit on` appears only after the runtime has observed evidence in the chain.

## Where policy is configured

The warden owns runtime policy evaluation. The built-in starter pack is named `phase2a-starter-policy-pack`; it is the default pack used by the current governed runtime unless a future owner-approved policy-pack selection path says otherwise.

Mode and grant choices that users can set today are stored in keel-owned user configuration, not in project files:

```sh
keel autopilot mode status
keel autopilot mode set guided
keel autopilot mode set autopilot
keel autopilot mode set project-autopilot
keel autopilot mode clear
keel autopilot grants list
keel autopilot grants revoke --domain <domain>
keel autopilot grants revoke --command-key <sha256:key>
```

Project files cannot raise autonomy, mark themselves trusted, or approve reviews. A workspace must be trusted before non-Guided mode configuration can become active, and already-running sessions do not silently change after a config edit.

Policy-pack authoring, alternate policy-pack loading, and organization-wide admin policy distribution are not TUI features in this preview. Until those surfaces exist, the footer and `/policies` are status displays, not policy editors.

## Mode labels

`Guided` is the default posture. Keel works under warden policy and may ask before risky, broad, external, destructive, or provenance-sensitive actions. Denials still deny.

`Autopilot` is high autonomy inside enforced boundaries. It can reduce prompts for actions the warden can already prove are contained and low-risk. It does not relax sandboxing, change a deny into an allow, trust project files, or rely on model confidence.

`Project Autopilot` is Autopilot plus persisted project-scope grants. It is for trusted projects only. It should display the exact authority granted, and those grants can be listed or revoked with `keel autopilot grants`.

`YOLO` is the design term for reduced or absent enforcement. The current preview CLI and TUI do not expose a YOLO switch; unsupported attempts are rejected rather than silently weakening protection. The governing spec still requires any future YOLO surface to be explicit, persistent, audited where possible, never the default, never a security claim, and visibly different from Autopilot.

Locked-down or stricter labels are policy/profile labels. They are meaningful only when they come from the warden-carried runtime status. The TUI must not infer a stricter mode from naming alone.

## Live review decisions

A review is actionable only while the warden has a live unresolved review. The TUI shows a focused `approval required` prompt for that current decision and says that Keel is paused until you choose.

Supported live decisions:

- `a` or `/approve once`: allow only the current pending action.
- `d` or `/deny`: deny the current action; it does not run.
- `?` or `/why`: explain the decision.
- `s` or `/approve session`: allow the exact domain or command envelope for this session only, when the review contains an exact resource.

`/reviews` is read-only. It is useful for seeing what happened, but stale receipts are not buttons. If a turn has already ended, the old review line cannot be approved from the transcript.

## Once, session, and project scope

Once scope releases only the current pending review. It does not remember anything.

Session exact-resource scope applies only to the exact domain or command envelope from that review, and only until the session exits. It is not a glob, a directory grant, or a project-wide trust decision.

Project scope is persisted only through the explicit Project Autopilot grant path. It must name the exact stored authority and remain revocable. The TUI should not offer a generic "approve and remember" button unless the warden has supplied an exact, supported grant path.

## Address exceptions are not grants

A hostname grant answers whether a domain may be contacted. A private-address exception answers a
different question: whether one exact hostname and port, for one resolved workspace, may use an
address inside one restricted CIDR. Both must match before the SRT connect-time guard allows the
connection.

Only a human manages exceptions through `keel egress exception add|list|remove`. They live in
keel-owned user configuration, not the project, and they cannot cover loopback, metadata, or other
hard-denied destinations. A running warden keeps its startup snapshot, so changing an exception does
not silently widen a live session; restart it to activate the new revision. Exact syntax and storage
details are in the [reference](reference.md#egress-address-exceptions).

## Admin checklist

1. Start with `keel autopilot mode status` to see configured mode and whether the workspace is trusted.
2. Use `keel autopilot grants list` to inspect persisted project grants.
3. Use `keel egress exception list --workspace <path>` to inspect separate private-address authority.
4. Use `/policies` in the TUI to inspect what the live session actually knows.
5. Use `/reviews` to audit review-needed receipts, but do not treat it as an approval surface.
6. Prefer Guided for unfamiliar or sensitive repos; use Autopilot only where the warden status, trust state, and grant scope are understood.

## Non-claims

This guide does not add a new policy engine, approval authority, sandbox claim, audit guarantee, policy-pack selector, admin console, or frozen protocol. It documents the current user/admin surfaces and the honesty rules they must preserve.
