import { describe, expect, it } from "vitest";
import { JUNK, assertRejects } from "../testing/property.js";
import { SIDE_EFFECT_TAXONOMY_VERSION, type SideEffectT } from "./side-effect.js";
import { PolicyInput, SessionMode } from "./input.js";

function validSideEffect(): SideEffectT {
  return {
    taxonomyVersion: SIDE_EFFECT_TAXONOMY_VERSION,
    staticCapability: { toolName: "bash", effectEnvelope: ["fs_read"], broad: false },
    dynamic: {
      effectKinds: ["fs_read"],
      scopes: ["workspace"],
      targets: [
        {
          kind: "path",
          value: "README.md",
          normalized: "/repo/README.md",
          withinWorkspace: true,
          sensitivity: "internal",
        },
      ],
      modifiers: [],
      composition: {
        kind: "atomic",
        segments: [
          {
            effectKinds: ["fs_read"],
            scopes: ["workspace"],
            targets: [
              {
                kind: "path",
                value: "README.md",
                normalized: "/repo/README.md",
                withinWorkspace: true,
                sensitivity: "internal",
              },
            ],
            modifiers: [],
          },
        ],
        edges: [],
      },
      classifier: { name: "shell-classifier", version: "0.0.0", confidence: "exact", reasons: [] },
    },
  };
}

describe("policy input document (Appendix D.1)", () => {
  it("round-trips the documented shape", () => {
    const sideEffect = validSideEffect();
    const input = {
      tool: { name: "bash", args: { command: "ls" } },
      normalized: { argv: ["ls"], decodedLayers: [] },
      workspace: { path: "/repo", trusted: true },
      provenance: { inputTags: ["workspace"] },
      sideEffect,
      egress: { isEgress: false, domain: null, gitRemote: null },
      session: {
        id: "ses_01J000000000000000000000XY",
        mode: "enforced",
        promptCountThisSession: 0,
      },
      principal: { osUser: "alice" },
    };
    const parsed = PolicyInput.parse(input);
    expect(PolicyInput.parse(parsed)).toEqual(parsed);
    const wire = JSON.parse(JSON.stringify(parsed)) as unknown;
    expect(PolicyInput.parse(wire)).toEqual(parsed);
    expect(SessionMode.options).toEqual(["enforced", "audit-only", "yolo"]);
    assertRejects(PolicyInput, [
      ...JUNK,
      // missing normalized
      {
        tool: { name: "bash", args: {} },
        workspace: { path: "/r", trusted: true },
        provenance: { inputTags: [] },
        sideEffect,
        egress: { isEgress: false, domain: null, gitRemote: null },
        session: {
          id: "ses_01J000000000000000000000XY",
          mode: "enforced",
          promptCountThisSession: 0,
        },
        principal: { osUser: "c" },
      },
      // missing sideEffect — every policy verdict must see the warden's classification
      {
        tool: { name: "bash", args: {} },
        normalized: { argv: ["ls"], decodedLayers: [] },
        workspace: { path: "/r", trusted: true },
        provenance: { inputTags: [] },
        egress: { isEgress: false, domain: null, gitRemote: null },
        session: {
          id: "ses_01J000000000000000000000XY",
          mode: "enforced",
          promptCountThisSession: 0,
        },
        principal: { osUser: "c" },
      },
      // malformed sideEffect — malformed classifications fail at the policy boundary
      {
        tool: { name: "bash", args: {} },
        normalized: { argv: ["ls"], decodedLayers: [] },
        workspace: { path: "/r", trusted: true },
        provenance: { inputTags: [] },
        sideEffect: { ...sideEffect, taxonomyVersion: "side-effect-taxonomy/v2" },
        egress: { isEgress: false, domain: null, gitRemote: null },
        session: {
          id: "ses_01J000000000000000000000XY",
          mode: "enforced",
          promptCountThisSession: 0,
        },
        principal: { osUser: "c" },
      },
    ]);
  });
});
