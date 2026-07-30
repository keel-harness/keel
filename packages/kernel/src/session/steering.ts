import { ulid } from "@keel/shared";
import type { SteeringClassT } from "@keel/shared";
import type { SessionStore } from "./store.js";

export interface SteeringInput {
  readonly class: SteeringClassT;
  readonly content: string;
  /** Override the generated input id. */
  readonly inputId?: string;
}

/**
 * Persist a mid-run steering input as a PENDING ledger event (§4.10): `insertedAt: null`,
 * flags `false`. Phase 1 only records it (so it survives resume as still-pending);
 * application — injecting it at a safe boundary and setting `insertedAt`/the flags — is
 * Epic 1.5/1.6. Returns the input id.
 */
export function recordSteering(store: SessionStore, input: SteeringInput): string {
  const inputId = input.inputId ?? `inp_${ulid()}`;
  store.append({
    type: "steering",
    v: 1,
    ts: new Date().toISOString(),
    inputId,
    class: input.class,
    content: input.content,
    insertedAt: null,
    changedTaskState: false,
    invalidatedPlan: false,
  });
  return inputId;
}

/** A steering input being applied at a safe boundary (Epic 1.5 slice 7). */
export interface AppliedSteering {
  readonly inputId: string;
  readonly class: SteeringClassT;
  readonly content: string;
}

/**
 * Apply a recorded steering input at a safe boundary (§4.10): append an applied steering marker
 * carrying the same `inputId` with `insertedAt` set — which `rebuild` treats as last-wins,
 * superseding the original pending event so it is never re-applied on resume — AND the injected
 * content as a real `user` event (so the model and resume both see it as a conversation message).
 * The append-only ledger has no in-place update; supersession via a later marker is how "mark
 * applied" works.
 *
 * Order matters: the **marker is written first**. The two appends are independently `fsync`'d, so a
 * crash between them must fail SAFE — marker-then-message means a crash leaves the input marked
 * applied (deduped, no longer pending) but its message absent: a benign drop the user can re-issue.
 * Message-then-marker would instead leave the message in the conversation AND the input still
 * pending, which a future re-drive (Epic 1.6) would inject a second time — corruption. Fail toward
 * loss, never duplication.
 *
 * `changedTaskState`/`invalidatedPlan` stay `false` — deliberately RESERVED, not faked (Epic 1.6b
 * slice 8b decision): there is no honest Phase-1 signal for them (verb syntax ≠ semantic intent, and
 * a ledger-derived "did the model re-plan after this" is only a soft heuristic) and no consumer yet
 * (the audit-backed receipt that reads them is Phase 2A). The structural guarantee keel makes
 * instead is that compaction never summarizes a steering instruction away (§4.10.2 — see
 * `context/compact.ts`); the model honors the constraint via its `plan` ledger + the system prompt.
 */
export function applySteering(
  store: SessionStore,
  input: AppliedSteering,
  insertedAt: number,
): void {
  const ts = new Date().toISOString();
  store.append({
    type: "steering",
    v: 1,
    ts,
    inputId: input.inputId,
    class: input.class,
    content: input.content,
    insertedAt,
    changedTaskState: false,
    invalidatedPlan: false,
  });
  store.append({ type: "user", v: 1, ts, content: input.content });
}
