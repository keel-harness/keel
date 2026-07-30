import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { keelHome } from "@keel/shared";
import { projectCommandGrantFilePath } from "./command-project-grants.js";
import { projectEgressGrantFilePath } from "./egress-grants.js";
import { resolveWardenKeelHome } from "./capability-manifest.js";

// P1-11 regression guard: every warden path that derives from keel's state directory must resolve
// from the ONE canonical `keelHome` (`@keel/shared`) — so the warden can never disagree with the
// kernel about where grants, trust, and the audit chain live. Before this fix there were five
// divergent resolvers (raw vs `resolve`d vs trim-checked, three different HOME fallbacks); a
// whitespace or relative KEEL_HOME silently sent grants and the deny-write roots to different dirs.
const TRICKY_ENVS: NodeJS.ProcessEnv[] = [
  { KEEL_HOME: "/srv/keel" },
  { KEEL_HOME: "  /srv/keel/  " }, // surrounding whitespace + trailing slash
  { KEEL_HOME: "relstate" }, // relative → must resolve to absolute
  { XDG_CONFIG_HOME: "/xdg" },
  { HOME: "/home/dana" },
  { KEEL_HOME: "   ", HOME: "/home/dana" }, // whitespace-only → treated as unset
];

describe("keelHome consistency — every warden path derives from the ONE canonical base (P1-11)", () => {
  for (const env of TRICKY_ENVS) {
    it(`agrees for env ${JSON.stringify(env)}`, () => {
      const base = keelHome(env);
      // The base is always an absolute path (never raw/relative/whitespace).
      expect(base.startsWith("/")).toBe(true);
      expect(resolveWardenKeelHome(env)).toBe(base);
      expect(projectCommandGrantFilePath(env)).toBe(join(base, "command-project-grants.json"));
      expect(projectEgressGrantFilePath(env)).toBe(join(base, "egress-project-grants.json"));
    });
  }
});
