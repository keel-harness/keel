import { z } from "zod";
import { SessionId } from "../common/formats.js";
import { ProvenanceTag } from "../rpc/primitives.js";
import { SideEffect } from "./side-effect.js";

/** Session enforcement mode seen by policy (free-ish but enumerated for v1). */
export const SessionMode = z.enum(["enforced", "audit-only", "yolo"]);
export type SessionModeT = z.infer<typeof SessionMode>;

/** The document every policy rule sees (MASTER_SPEC Appendix D §D.1). Not frozen.
 *  `principal` here is the minimal `{osUser}` the appendix shows (the full
 *  Principal w/ identity seam lives on the RPC + audit record). */
export const PolicyInput = z
  .object({
    tool: z.object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()) }).strict(),
    normalized: z
      .object({ argv: z.array(z.string()), decodedLayers: z.array(z.string()) })
      .strict(),
    sideEffect: SideEffect,
    workspace: z.object({ path: z.string().min(1), trusted: z.boolean() }).strict(),
    provenance: z.object({ inputTags: z.array(ProvenanceTag) }).strict(),
    egress: z
      .object({
        isEgress: z.boolean(),
        domain: z.string().nullable(),
        gitRemote: z.string().nullable(),
      })
      .strict(),
    session: z
      .object({
        id: SessionId,
        mode: SessionMode,
        promptCountThisSession: z.number().int().nonnegative(),
      })
      .strict(),
    principal: z.object({ osUser: z.string().min(1) }).strict(),
  })
  .strict();
export type PolicyInputT = z.infer<typeof PolicyInput>;
