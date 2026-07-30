import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  presentationRedactionSpans,
  redactJsonKeysAndValues,
  redactJsonLine,
  redactJsonValue,
  redactText,
} from "./redact.js";
import { Ed25519Sig } from "../common/formats.js";
import { Ed25519PublicKey } from "../audit/evidence-bundle.js";

// The pure `redactText` filter (SEC-014, §3.2(6)) lives in @keel/shared so it is the ONE redaction
// implementation used by every keel write chokepoint (the kernel session ledger AND the @keel/eval
// benchmark trajectory store). These cases test the filter in isolation; the kernel's
// SessionStore-append integration (SEC-014 at the session chokepoint) is tested in @keel/kernel.

describe("redactText — provider-key format catalog (SEC-014, §3.2(6))", () => {
  const cases: ReadonlyArray<readonly [label: string, secret: string]> = [
    ["Anthropic", "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA"],
    ["OpenAI project", "sk-proj-abcDEF1234567890abcDEF1234567890abcDEF12"],
    ["OpenAI classic", "sk-abcDEF1234567890abcDEF1234567890abcDEF12"],
    ["Google AI", "AIzaSyA1234567890abcdefghijklmnopqrstuvw"],
    ["AWS access key id", "AKIAIOSFODNN7EXAMPLE"],
    ["GitHub PAT", "ghp_abcDEF1234567890abcDEF1234567890abcDEF"],
    ["Slack bot token", "xoxb-123456789012-1234567890123-abcdefABCDEF0123456789ab"],
  ];

  for (const [label, secret] of cases) {
    it(`redacts a ${label} key embedded in surrounding text`, () => {
      const out = redactText(`before ${secret} after`);
      expect(out).not.toContain(secret);
      expect(out).toMatch(/before .*after/);
      expect(out).toMatch(/\[redacted:/); // honest, marked, not silently dropped
    });
  }

  it("redacts a PEM private-key block whole", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactText(`key:\n${pem}\ndone`);
    expect(out).not.toContain("b3BlbnNzaC1rZXk");
    expect(out).toContain("done");
    expect(out).toMatch(/\[redacted:private-key\]/);
  });

  it("redacts every occurrence, not just the first", () => {
    const k = "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA";
    const out = redactText(`${k} and again ${k}`);
    expect(out).not.toContain(k);
    expect(out.match(/\[redacted:/g)?.length).toBe(2);
  });

  it("leaves ordinary prose and short tokens untouched (no over-redaction in the catalog)", () => {
    const text = "the quick brown fox ran 12 tests and committed abc123 to main";
    expect(redactText(text)).toBe(text);
  });
});

describe("redactText — entropy heuristic (secondary net) with false-positive guards", () => {
  it("redacts a long high-entropy mixed token not covered by the catalog", () => {
    const tok = "Zx9Kp2Lm7Qw4Nv8Rt3Yb6Hc1Jf5Gd0Sa2We4Tr6Uy8Io0Pl3"; // 49 chars, letters+digits
    const out = redactText(`token=${tok} end`);
    expect(out).not.toContain(tok);
    expect(out).toMatch(/\[redacted:high-entropy\]/);
    expect(out).toContain("end");
  });

  it("entropyNet:false skips the heuristic but STILL catches known formats + contextual creds", () => {
    const tok = "Zx9Kp2Lm7Qw4Nv8Rt3Yb6Hc1Jf5Gd0Sa2We4Tr6Uy8Io0Pl3"; // would be caught by the net
    const key = "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA";
    const out = redactText(
      `key=${key} hash=${tok} url=https://u:p@host.com/x auth=Authorization: Bearer abc.def.ghi`,
      { entropyNet: false },
    );
    // the high-entropy non-format token is PRESERVED (faithful content, e.g. an artifact hash)
    expect(out).toContain(tok);
    expect(out).not.toMatch(/\[redacted:high-entropy\]/);
    // but the known-format provider key + the contextual creds are STILL redacted
    expect(out).not.toContain(key);
    expect(out).toContain("[redacted:anthropic-key]");
    expect(out).toContain("[redacted:url-credential]");
    expect(out).toContain("[redacted:auth-header]");
  });

  // Legitimate high-entropy-LOOKING identifiers that MUST survive (redacting them corrupts the ledger).
  const benign: ReadonlyArray<readonly [label: string, value: string]> = [
    ["uuid", "550e8400-e29b-41d4-a716-446655440000"],
    ["sha256 hex", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["git sha", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"],
    ["pure number run", "12345678901234567890123456789012345678901234"],
    ["ULID (session id, 26 chars)", "01J9ZX8K3QABCDEFGHJKMNPQRS"],
  ];
  for (const [label, value] of benign) {
    it(`does NOT redact a ${label}`, () => {
      const text = `id is ${value} here`;
      expect(redactText(text)).toBe(text);
    });
  }

  it("does NOT redact long ordinary prose (whitespace breaks the run)", () => {
    const prose =
      "this is a perfectly ordinary sentence with many words and no secrets at all whatsoever";
    expect(redactText(prose)).toBe(prose);
  });

  it("does NOT redact a long letters-only run (no digits → not credential-shaped)", () => {
    const word = "a".repeat(50); // 50 chars, ≥ the length bar, but lacks digits
    expect(redactText(`x ${word} y`)).toContain(word);
  });

  it("does NOT redact a long symbol-only run (no letters → not credential-shaped)", () => {
    const run = "_".repeat(50); // ≥ the length bar, but lacks letters AND digits
    expect(redactText(`x ${run} y`)).toContain(run);
  });

  it("preserves a long absolute workspace path while still redacting a secret-shaped filename", () => {
    const workspace = "/private/tmp/keel-redaction-fixture/workspace";
    expect(redactText(workspace)).toBe(workspace);

    const secret = "Zx9Kp2Lm7Qw4Nv8Rt3Yb6Hc1Jf5Gd0Sa2We4Tr6Uy8Io0Pl3";
    const redacted = redactText(`${workspace}/${secret}`);
    expect(redacted).toContain(workspace);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[redacted:high-entropy]");
  });
});

describe("redactText — credentials in a textual context (Epic 1.9 QC, S7)", () => {
  it("redacts URL-embedded basic-auth credentials, keeping the scheme and host", () => {
    const out = redactText("clone https://alice:s3cr3t-token@github.com/org/repo.git now");
    expect(out).not.toContain("s3cr3t-token");
    expect(out).not.toContain("alice:s3cr3t");
    expect(out).toContain("github.com/org/repo.git"); // host/path survive
    expect(out).toMatch(/\[redacted:url-credential\]/);
  });

  it("redacts a password that itself contains an '@' (greedy to the last '@')", () => {
    const out = redactText("db at https://admin:P@ss0rd@db.internal/x");
    expect(out).not.toContain("P@ss0rd");
    expect(out).toContain("db.internal/x");
  });

  it("redacts credentials in NON-http(s) URL schemes (DB/queue connection strings)", () => {
    for (const url of [
      "postgres://admin:hunter2pw@db.host:5432/app",
      "redis://default:s3cr3t@cache:6379/0",
      "mongodb://u:p4ss@mongo/db",
      "amqp://guest:guestpw@rabbit:5672",
    ]) {
      const out = redactText(`connect ${url} now`);
      expect(out).toMatch(/\[redacted:url-credential\]/);
      expect(out).not.toMatch(/hunter2pw|s3cr3t|p4ss|guestpw/);
    }
  });

  it("does NOT touch an ordinary URL with no credentials (no over-redaction)", () => {
    const url = "see https://api.example.com:8080/v1/users for docs";
    expect(redactText(url)).toBe(url);
  });

  it("redacts an Authorization: Bearer/Basic header value (incl. a header JWT)", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dQw4w9WgXcQ_signature_value_here";
    const bearer = redactText(`Authorization: Bearer ${jwt}`);
    expect(bearer).not.toContain(jwt);
    expect(bearer).toMatch(/Authorization: Bearer \[redacted:auth-header\]/);
    const basic = redactText("authorization: Basic dXNlcjpzdXBlcnNlY3JldA==");
    expect(basic).not.toContain("dXNlcjpzdXBlcnNlY3JldA==");
    expect(basic).toMatch(/\[redacted:auth-header\]/);
  });
});

describe("presentationRedactionSpans — direct typed source spans (Epic 3.10 Slice 2B-S7)", () => {
  it("returns exact catalog spans while marker-shaped source text remains literal", () => {
    const secret = "sk-proj-abcDEF1234567890abcDEF1234567890abcDEF12";
    const input = `literal [redacted:openai-key] then ${secret} done`;

    expect(presentationRedactionSpans(input)).toEqual([
      {
        start: input.indexOf(secret),
        end: input.indexOf(secret) + secret.length,
        kind: "openai-key",
      },
    ]);
  });

  it("returns only URL userinfo and authorization values for contextual credentials", () => {
    const userinfo = "alice:P@ss0rd";
    const authorization = "abc.def.ghi";
    const input =
      `db=https://${userinfo}@db.example.test/x ` + `Authorization: Bearer ${authorization}`;

    expect(presentationRedactionSpans(input, { entropyNet: false })).toEqual([
      {
        start: input.indexOf(userinfo),
        end: input.indexOf(userinfo) + userinfo.length,
        kind: "url-credential",
      },
      {
        start: input.indexOf(authorization),
        end: input.indexOf(authorization) + authorization.length,
        kind: "auth-header",
      },
    ]);
  });

  it("returns one span for a private-key block crossing logical lines", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----";
    const input = `before ${pem} after`;

    expect(presentationRedactionSpans(input, { entropyNet: false })).toEqual([
      {
        start: input.indexOf(pem),
        end: input.indexOf(pem) + pem.length,
        kind: "private-key",
      },
    ]);
  });

  it("returns a direct high-entropy span and a secret-shaped path-component span", () => {
    const secret = "Zx9Kp2Lm7Qw4Nv8Rt3Yb6Hc1Jf5Gd0Sa2We4Tr6Uy8Io0Pl3";
    const standalone = `token ${secret}`;
    const path = `/workspace/${secret}/artifact`;

    expect(presentationRedactionSpans(standalone)).toEqual([
      {
        start: standalone.indexOf(secret),
        end: standalone.indexOf(secret) + secret.length,
        kind: "high-entropy",
      },
    ]);
    expect(presentationRedactionSpans(path)).toEqual([
      {
        start: path.indexOf(secret),
        end: path.indexOf(secret) + secret.length,
        kind: "high-entropy",
      },
    ]);
  });

  it("keeps catalog precedence when an authorization rule overlaps the same provider key", () => {
    const secret = "sk-proj-abcDEF1234567890abcDEF1234567890abcDEF12";
    const input = `Authorization: Bearer ${secret}`;

    expect(presentationRedactionSpans(input)).toEqual([
      {
        start: input.indexOf(secret),
        end: input.indexOf(secret) + secret.length,
        kind: "openai-key",
      },
    ]);
  });

  it("extends a catalog match across the complete overlapping contextual credential", () => {
    const providerKey = "sk-proj-abcDEF1234567890abcDEF1234567890abcDEF12";
    const authorization = `prefix-${providerKey}`;
    const userinfo = `alice:${providerKey}`;
    const input =
      `Authorization: Bearer ${authorization} ` + `db=postgres://${userinfo}@db.example.test/x`;

    expect(presentationRedactionSpans(input, { entropyNet: false })).toEqual([
      {
        start: input.indexOf(authorization),
        end: input.indexOf(authorization) + authorization.length,
        kind: "openai-key",
      },
      {
        start: input.indexOf(userinfo),
        end: input.indexOf(userinfo) + userinfo.length,
        kind: "openai-key",
      },
    ]);
  });

  it("does not create spans for benign long identifiers", () => {
    expect(
      presentationRedactionSpans(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ),
    ).toEqual([]);
  });

  it("property: every catalog-shaped provider key is covered by a direct source span", () => {
    const providerKey: fc.Arbitrary<string> = fc.oneof(
      fc.stringMatching(/^sk-ant-[A-Za-z0-9_-]{20,50}$/),
      fc.stringMatching(/^sk-(?:proj-)?[A-Za-z0-9_-]{20,48}$/),
      fc.stringMatching(/^AIza[0-9A-Za-z_-]{35,38}$/),
      fc.stringMatching(/^AKIA[0-9A-Z]{16}$/),
      fc.stringMatching(/^ghp_[A-Za-z0-9]{36,40}$/),
      fc.stringMatching(/^xoxb-[A-Za-z0-9-]{12,40}$/),
    );

    fc.assert(
      fc.property(providerKey, (key) => {
        const input = `prefix ${key} suffix`;
        const covered = presentationRedactionSpans(input).some(
          (span) => span.start <= input.indexOf(key) && span.end >= input.indexOf(key) + key.length,
        );
        expect(covered).toBe(true);
      }),
    );
  });
});

describe("redactText — property: a well-formed provider key never survives (SPEC-7)", () => {
  // Each arbitrary generates a string MATCHING a catalog format (prefix + a body in that format's
  // alphabet, at/above its length floor) via `stringMatching`. The property: redaction always removes
  // it, leaving a marker — across the fuzzed key space, not just the handful of hard-coded examples.
  const providerKey: fc.Arbitrary<string> = fc.oneof(
    fc.stringMatching(/^sk-ant-[A-Za-z0-9_-]{20,50}$/),
    fc.stringMatching(/^sk-(?:proj-)?[A-Za-z0-9_-]{20,48}$/),
    fc.stringMatching(/^AIza[0-9A-Za-z_-]{35,38}$/),
    fc.stringMatching(/^AKIA[0-9A-Z]{16}$/),
    fc.stringMatching(/^ghp_[A-Za-z0-9]{36,40}$/),
    fc.stringMatching(/^xoxb-[A-Za-z0-9-]{12,40}$/),
  );

  it("redacts any catalog-shaped key embedded in surrounding text", () => {
    fc.assert(
      fc.property(providerKey, (key) => {
        const out = redactText(`log: token=${key} <- end`);
        expect(out).not.toContain(key);
        expect(out).toContain("<- end");
        expect(out).toMatch(/\[redacted:/);
      }),
    );
  });

  it("redacting an already-serialized JSON line keeps it valid JSON and key-free", () => {
    fc.assert(
      fc.property(providerKey, (key) => {
        const line = redactJsonLine(JSON.stringify({ note: `key is ${key}` }));
        expect(line).not.toContain(key);
        expect(() => {
          JSON.parse(line);
        }).not.toThrow();
      }),
    );
  });
});

describe("redactJsonLine — F1 integrity: a redacted serialized JSON line ALWAYS round-trips", () => {
  // A structured-redaction regression found a capped ~284KB→~40KB search result whose redacted
  // `tool_result`
  // line was INVALID JSON: the entropy net matched a run that began at the `n` of an escaped `\n`
  // newline separating two grep hits, redacting `\nSECRET…` to `\[redacted:high-entropy]` — a lone
  // `\` left an invalid `\[` escape, so a strict parser (jq / json.loads) SILENTLY DROPPED the line.
  // The defect is structural: `redactText` over an already-serialized line can split a JSON escape.
  // `redactJsonLine` must redact the decoded values, so serialization re-escapes AFTER redaction and
  // the line is valid by construction.

  it("the exact escaped-newline shape with high-entropy tokens round-trips", () => {
    // Two grep hits, each a high-entropy secret-like token, joined by a newline — mirrors the real line.
    const secret = "riGp58WAmdX3a5IDnOdcdbWB2dC4DSDC6Lc1mxLpQ2y9abcDEF"; // 49 chars, mixed, high-entropy
    const output = [
      `${secret}.json:5:22:    "sources": "s3://b/x.gz",`,
      `${secret}.json:6:1:    "n"`,
    ].join("\n");
    const line = redactJsonLine(JSON.stringify({ type: "tool_result", output }));
    // round-trips AND actually redacted the secret
    const parsed = JSON.parse(line) as { output: string };
    expect(line).not.toContain(secret);
    expect(parsed.output).toContain("[redacted:high-entropy]");
  });

  it("property: an adversarial value redacts to exactly one valid JSON line", () => {
    // Adversarial leaves: high-entropy tokens (entropy-net bait) interleaved with the exact chars that
    // become JSON escapes (newline, tab, quote, backslash, control chars, multibyte/astral runs).
    const hot = fc.constantFrom(
      "\n",
      "\t",
      "\r",
      '"',
      "\\",
      "\b",
      "\f",
      " ",
      "",
      "é",
      "🔑",
      "Zx9Kp2Lm7Qw4Nv8Rt3Yb6Hc1Jf5Gd0Sa2We4Tr6Uy8Io0Pl3", // 49-char high-entropy token
      "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA", // catalog key
    );
    const value = fc
      .array(fc.oneof(hot, fc.string()), { maxLength: 40 })
      .map((parts) => parts.join(""));
    fc.assert(
      fc.property(value, fc.string({ maxLength: 8 }), (output, key) => {
        const line = redactJsonLine(JSON.stringify({ k: key, output }));
        // exactly one valid JSON value — never a dropped/torn line under a strict parser
        const parsed: unknown = JSON.parse(line);
        expect(typeof parsed).toBe("object");
        expect(parsed).not.toBeNull();
      }),
    );
  });

  it("equals redactText on each decoded string value (same redaction power, JSON-safely)", () => {
    const key = "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA";
    const obj = { type: "tool_result", output: `env ANTHROPIC_API_KEY=${key} here` };
    const line = redactJsonLine(JSON.stringify(obj));
    const parsed = JSON.parse(line) as { output: string };
    expect(parsed.output).toBe(redactText(obj.output));
    expect(parsed.output).toContain("[redacted:anthropic-key]");
  });

  it("honors entropyNet:false (faithful high-entropy content survives, known formats still go)", () => {
    const tok = "Zx9Kp2Lm7Qw4Nv8Rt3Yb6Hc1Jf5Gd0Sa2We4Tr6Uy8Io0Pl3";
    const key = "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA";
    const line = redactJsonLine(JSON.stringify({ hash: tok, key }), { entropyNet: false });
    const parsed = JSON.parse(line) as { hash: string; key: string };
    expect(parsed.hash).toBe(tok); // faithful content kept
    expect(parsed.key).toContain("[redacted:anthropic-key]"); // known format still redacted
  });

  // The #1 regression risk of the per-leaf `redactJsonValue` recursion vs. the old brute-force
  // whole-string `redactText(JSON.stringify(...))` pass: a secret buried in a DEEPLY NESTED field
  // (object → array → object → object → string) must still be reached. The old pass scanned the
  // entire serialized blob and so was depth-blind by construction; the new path only redacts what
  // the recursion descends into, so a missed nesting level would silently LEAK the secret. This
  // proves the recursion is complete to ≥4 levels and the line still round-trips.
  it("redacts a secret buried ≥4 levels deep (object→array→object→object→string)", () => {
    const SECRET = "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA";
    const line = redactJsonLine(JSON.stringify({ a: { b: [{ c: { note: `token ${SECRET}` } }] } }));
    // the serialized line carries the secret NOWHERE, but the honest marker IS present
    expect(line).not.toContain(SECRET);
    expect(line).toContain("[redacted:anthropic-key]");
    // …and the redacted line is still exactly one valid JSON value that round-trips structurally
    const parsed = JSON.parse(line) as { a: { b: [{ c: { note: string } }] } };
    expect(parsed.a.b[0].c.note).toBe("token [redacted:anthropic-key]");
  });

  // ER-033 (per-chokepoint `entropyNet`): the SAME value, opposite outcomes, proving the option
  // threads through the redacted-before-serialize path exactly as the two real chokepoints pass it.
  // The trajectory store (@keel/eval) calls `redactJsonValue(value, { entropyNet: false })` so a
  // faithful high-entropy artifact reaches the §2.3 analysis loop intact; the session ledger
  // (@keel/kernel) calls it with the default (full filter, entropy net ON) since it can carry
  // unknown-format secrets. The probe value is a 54-char high-entropy token matching NO catalog
  // format and NO contextual scheme — so ONLY the entropy net can catch it. (If `entropyNet` were
  // not actually threaded through `redactJsonValue`, the PRESERVE assertion below would fail.)
  it("threads the per-chokepoint entropyNet option through redactJsonValue (ER-033)", () => {
    const tok = "Zx9Kp2Lm7Qw4Nv8Rt3Yb6Hc1Jf5Gd0Sa2We4Tr6Uy8Io0Pl3aB7cDe"; // 54 chars, net-only
    const value = { hash: `recovered: ${tok}` };

    // trajectory-store chokepoint opts → entropy net OFF → the faithful artifact is PRESERVED
    const preserved = redactJsonValue(value, { entropyNet: false }) as { hash: string };
    expect(preserved.hash).toContain(tok);
    expect(preserved.hash).not.toContain("[redacted:high-entropy]");

    // session-store chokepoint opts → default (full filter, net ON) → the SAME token is REDACTED
    const redacted = redactJsonValue(value) as { hash: string };
    expect(redacted.hash).not.toContain(tok);
    expect(redacted.hash).toContain("[redacted:high-entropy]");
  });
});

describe("redactJsonKeysAndValues — redacts model-controlled object KEYS too (QC §6)", () => {
  const secret = "sk-ant-api03-abcDEF123456789_ghijklmnop-qrstuvwxyz0123456789AA";

  it("redacts a secret in a KEY, not only a value", () => {
    const out = redactJsonKeysAndValues({ [secret]: "1", path: "src/x.ts" }) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(Object.keys(out).some((k) => k.includes("[redacted:"))).toBe(true);
    expect(out["path"]).toBe("src/x.ts"); // benign key preserved
  });

  it("redacts a secret in a NESTED key", () => {
    const out = redactJsonKeysAndValues({ args: { [secret]: "v" } });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it("still redacts secret VALUES (parity with redactJsonValue)", () => {
    const out = redactJsonKeysAndValues({ token: secret });
    expect(JSON.stringify(out)).not.toContain(secret);
  });

  it("spares a benign high-entropy id used as a key (ULID/uuid/long id) — no entropy net on keys", () => {
    const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    // The load-bearing case: a ≥44-char high-entropy id the entropy NET would flag if it ran, but
    // which is a legitimate key — redacting it would mangle the record. entropyNet:false spares it.
    const longId = "tc_Zx9Kp2Lm7Qw4Nv8Rt3Yb6Hc1Jf5Gd0Sa2We4Tr6Uy8Io";
    expect(redactText(longId)).toMatch(/\[redacted:high-entropy\]/); // net-on WOULD redact this
    const out = redactJsonKeysAndValues({ [ulid]: 1, [uuid]: 2, [longId]: 3 }) as Record<
      string,
      unknown
    >;
    expect(Object.keys(out)).toContain(ulid);
    expect(Object.keys(out)).toContain(uuid);
    expect(Object.keys(out)).toContain(longId);
  });

  it("leaves fixed schema keys untouched", () => {
    const out = redactJsonKeysAndValues({ toolCallId: "tc_1", toolName: "read", args: {} });
    expect(Object.keys(out as object).sort()).toEqual(["args", "toolCallId", "toolName"]);
  });
});

describe("entropy-net landmines — shapes the net destroys, pinned so no one routes them through it", () => {
  // Deterministic near-uniform base64: 37 is coprime with 64, so the index cycles the whole
  // alphabet — high Shannon entropy, mixed letters+digits, not all-hex.
  const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const b64 = (n: number) =>
    Array.from({ length: n }, (_, i) => B64_ALPHABET[(i * 37 + 11) % 64]).join("");

  it("a format-valid Ed25519 signature and public key are destroyed by the entropy net", () => {
    // Ed25519Sig is 86 base64 chars + `==` (88-char run); Ed25519PublicKey is 43 + `=` — EXACTLY
    // the net's 44-char floor. Both are therefore inside the net. This is safe today ONLY because
    // no signature or public key transits a value-redacting chokepoint: the audit writer redacts
    // BEFORE hashing/signing, and checkpoint/bundle records skip redaction by design. Anyone who
    // routes a sig or pubkey through `redactText`/`redactJsonValue`/`redactJsonLine` as a VALUE
    // will corrupt it — this pin makes that failure visible at the filter, not in a broken chain.
    const sig = `ed25519:${b64(86)}==`;
    const pub = `ed25519:${b64(43)}=`;
    expect(Ed25519Sig.safeParse(sig).success).toBe(true);
    expect(Ed25519PublicKey.safeParse(pub).success).toBe(true);
    expect(redactText(sig)).toBe("ed25519:[redacted:high-entropy]");
    expect(redactText(pub)).toBe("ed25519:[redacted:high-entropy]");
  });
});
