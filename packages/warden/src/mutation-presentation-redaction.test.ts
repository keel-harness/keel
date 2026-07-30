import type { MutationPresentationSegmentV1T, MutationPresentationTextV1T } from "@keel/shared";
import { describe, expect, it, vi } from "vitest";
import {
  MUTATION_PRESENTATION_MAX_LINE_BYTES,
  MUTATION_PRESENTATION_MAX_INDEXED_LINES,
  MUTATION_PRESENTATION_MAX_REDACTION_BYTE_VISITS,
  MUTATION_PRESENTATION_MAX_REDACTION_METADATA_RECORDS,
  MUTATION_PRESENTATION_YIELD_BYTE_WORK,
  MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS,
  type MutationPresentationConstructionControl,
  type MutationPresentationConstructionWork,
} from "./mutation-presentation-walking-skeleton.js";
import { createMutationPresentationConstructionControl } from "./mutation-presentation-bounds.js";
import { redactMutationPresentationLines } from "./mutation-presentation-redaction.js";

const OPENAI_SECRET = `sk-proj-${"A1b2C3d4E5f6G7h8I9j0"}`;
const AUTH_SECRET = "Z3b9Y2c8X1a7W4v6U0t5S8r2Q9p1N7m3K6j4H8g2";

function renderSegments(segments: readonly MutationPresentationSegmentV1T[]): string {
  return segments
    .map((segment) => (segment.kind === "literal" ? segment.text : "[redacted]"))
    .join("");
}

function renderText(text: MutationPresentationTextV1T): string {
  return renderSegments(text.segments);
}

function recordingControl(): {
  readonly control: MutationPresentationConstructionControl;
  readonly work: MutationPresentationConstructionWork[];
} {
  const work: MutationPresentationConstructionWork[] = [];
  return {
    work,
    control: {
      checkpoint: async () => undefined,
      account: async (entry) => {
        work.push(entry);
      },
    },
  };
}

describe("Epic 3.10 Slice 2B-S7 structured mutation-presentation redaction", () => {
  it("scans the full source while bounding aggregate rendered output", async () => {
    const { control } = recordingControl();
    const result = await redactMutationPresentationLines(
      ["x".repeat(100), `hidden ${OPENAI_SECRET}`],
      {
        control,
        maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES,
        maxRenderedBytesTotal: 10,
      },
    );

    expect(result.outputTruncated).toBe(true);
    expect(result.lines).toHaveLength(1);
    expect(result.redactionCount).toBe(1);
    expect(JSON.stringify(result.lines)).not.toContain(OPENAI_SECRET);
  });

  it("emits typed redaction segments without interpreting marker-shaped literal text", async () => {
    const { control } = recordingControl();
    const result = await redactMutationPresentationLines(
      [`literal [redacted:openai-key] marker`, `secret ${OPENAI_SECRET} tail`],
      { control, maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES },
    );

    expect(result.redactionCount).toBe(1);
    expect(result.lines[0]).toEqual({
      text: {
        segments: [{ kind: "literal", text: "literal [redacted:openai-key] marker" }],
        redactionCount: 0,
      },
      truncated: false,
    });
    expect(result.lines[1]?.text.segments).toEqual([
      { kind: "literal", text: "secret " },
      { kind: "redacted" },
      { kind: "literal", text: " tail" },
    ]);
    expect(result.lines[1]?.text.redactionCount).toBe(1);
  });

  it("redacts one PEM block and a split authorization credential across logical lines", async () => {
    const { control } = recordingControl();
    const result = await redactMutationPresentationLines(
      [
        "before -----BEGIN PRIVATE KEY-----",
        "private-material",
        "-----END PRIVATE KEY----- after",
        "Authorization: Bearer",
        AUTH_SECRET,
      ],
      { control, maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES },
    );

    expect(result.redactionCount).toBe(2);
    expect(result.lines.map((line) => renderText(line.text))).toEqual([
      "before [redacted]",
      "",
      " after",
      "Authorization: Bearer",
      "[redacted]",
    ]);
    expect(result.lines.map((line) => line.text.redactionCount)).toEqual([1, 0, 0, 0, 1]);
  });

  it("neutralizes terminal, C0/C1, bidi, and line-separator controls into visible literals", async () => {
    const { control } = recordingControl();
    const hostile = `\u0000\t\r\u001b\u009b\u202e\u2028\u2029safe`;
    const result = await redactMutationPresentationLines([hostile], {
      control,
      maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES,
    });
    const rendered = renderText(result.lines[0]!.text);

    expect(rendered).toBe("␀␉␍␛‹U+009B›‹U+202E›‹U+2028›‹U+2029›safe");
    expect(
      [...rendered].some((character) => {
        const codePoint = character.codePointAt(0)!;
        return (
          codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          (codePoint >= 0x202a && codePoint <= 0x202e) ||
          (codePoint >= 0x2066 && codePoint <= 0x2069)
        );
      }),
    ).toBe(false);
  });

  it("neutralizes controls before applying the rendered UTF-8 byte ceiling", async () => {
    const { control } = recordingControl();
    const result = await redactMutationPresentationLines([`A\u001bB`], {
      control,
      maxRenderedBytesPerLine: 4,
    });

    expect(renderText(result.lines[0]!.text)).toBe("A␛");
    expect(Buffer.byteLength(renderText(result.lines[0]!.text), "utf8")).toBe(4);
    expect(result.lines[0]!.truncated).toBe(true);
  });

  it("truncates only at complete UTF-8 scalar boundaries", async () => {
    const { control } = recordingControl();
    const result = await redactMutationPresentationLines(["ééé", "🙂🙂"], {
      control,
      maxRenderedBytesPerLine: 5,
    });

    expect(result.lines.map((line) => renderText(line.text))).toEqual(["éé", "🙂"]);
    expect(result.lines.every((line) => line.truncated)).toBe(true);
    expect(result.lines.map((line) => renderText(line.text))).not.toContain("�");
  });

  it("redacts before truncation so no partial secret can survive at the display cut", async () => {
    const { control } = recordingControl();
    const result = await redactMutationPresentationLines([`aa ${OPENAI_SECRET} suffix`], {
      control,
      maxRenderedBytesPerLine: 13,
    });

    expect(renderText(result.lines[0]!.text)).toBe("aa [redacted]");
    expect(result.lines[0]!.text.redactionCount).toBe(1);
    expect(result.lines[0]!.truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain(OPENAI_SECRET);
  });

  it("accounts large scans in cooperative chunks no larger than the accepted byte-yield interval", async () => {
    const { control, work } = recordingControl();
    const longLine = `${"ordinary text ".repeat(12_000)} ${OPENAI_SECRET}`;
    const result = await redactMutationPresentationLines([longLine], {
      control,
      maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES,
    });

    expect(result.lines[0]!.truncated).toBe(true);
    expect(work.length).toBeGreaterThan(1);
    const redactionVisits = work.filter((entry) => (entry.redactionByteVisits ?? 0) > 0);
    expect(redactionVisits.length).toBeGreaterThan(1);
    expect(
      redactionVisits.every(
        (entry) => (entry.redactionByteVisits ?? 0) <= MUTATION_PRESENTATION_YIELD_BYTE_WORK,
      ),
    ).toBe(true);
  });

  it("keeps an over-window low-entropy provider or authorization token fully redacted", async () => {
    const { control } = recordingControl();
    const longProviderSecret = `sk-proj-${"A".repeat(70 * 1024)}`;
    const longAuthorizationSecret = "B".repeat(70 * 1024);
    const result = await redactMutationPresentationLines(
      [longProviderSecret, `Authorization: Bearer ${longAuthorizationSecret}`],
      { control, maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES },
    );

    expect(result.lines.map((line) => renderText(line.text))).toEqual([
      "[redacted]",
      "Authorization: Bearer [redacted]",
    ]);
    expect(JSON.stringify(result)).not.toContain("A".repeat(100));
    expect(JSON.stringify(result)).not.toContain("B".repeat(100));
  });

  it("accounts long credential extension scans before any yield interval can be exceeded", async () => {
    const inputs = [
      `sk-proj-${"A".repeat(140 * 1024)}`,
      `postgres://user:${"p".repeat(140 * 1024)}@db.example.test/path`,
    ];

    for (const input of inputs) {
      let scalarConversionsSinceAccount = 0;
      let maximumScalarConversionsBetweenAccounts = 0;
      const originalFromCodePoint = String.fromCodePoint.bind(String);
      const fromCodePoint = vi
        .spyOn(String, "fromCodePoint")
        .mockImplementation((...codePoints) => {
          scalarConversionsSinceAccount += codePoints.length;
          return originalFromCodePoint(...codePoints);
        });
      const control: MutationPresentationConstructionControl = {
        checkpoint: async () => undefined,
        account: async () => {
          maximumScalarConversionsBetweenAccounts = Math.max(
            maximumScalarConversionsBetweenAccounts,
            scalarConversionsSinceAccount,
          );
          scalarConversionsSinceAccount = 0;
        },
      };

      try {
        await redactMutationPresentationLines([input], {
          control,
          maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES,
        });
        maximumScalarConversionsBetweenAccounts = Math.max(
          maximumScalarConversionsBetweenAccounts,
          scalarConversionsSinceAccount,
        );
      } finally {
        fromCodePoint.mockRestore();
      }

      expect(maximumScalarConversionsBetweenAccounts).toBeLessThanOrEqual(
        MUTATION_PRESENTATION_YIELD_SCALAR_OPERATIONS,
      );
    }
  });

  it("redacts URL userinfo even when the final at-sign falls beyond one overlap window", async () => {
    const { control } = recordingControl();
    const longPassword = "p".repeat(70 * 1024);
    const result = await redactMutationPresentationLines(
      [`postgres://user:${longPassword}@db.example.test/path`],
      { control, maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES },
    );

    expect(renderText(result.lines[0]!.text)).toBe("postgres://[redacted]@db.example.test/path");
    expect(result.lines[0]!.text.redactionCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("p".repeat(100));
  });

  it("redacts every nested scheme candidate instead of skipping a later credential", async () => {
    const { control } = recordingControl();
    const input = "x://u:first@y://v:second@host";
    const result = await redactMutationPresentationLines([input], {
      control,
      maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES,
    });

    expect(renderText(result.lines[0]!.text)).toBe("x://[redacted]@y://[redacted]@host");
    expect(JSON.stringify(result)).not.toMatch(/first|second/u);
  });

  it("redacts a complete contextual credential that only partly overlaps a provider match", async () => {
    const providerKey = "sk-proj-abcDEF1234567890abcDEF1234567890abcDEF12";
    const authorization = `prefix-${providerKey}`;
    const userinfo = `alice:${providerKey}`;
    const { control } = recordingControl();
    const result = await redactMutationPresentationLines(
      [`Authorization: Bearer ${authorization}`, `postgres://${userinfo}@db.example.test/x`],
      { control, maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES },
    );

    expect(result.lines.map((line) => renderText(line.text))).toEqual([
      "Authorization: Bearer [redacted]",
      "postgres://[redacted]@db.example.test/x",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/prefix-|alice:/u);
  });

  it("conservatively redacts from an unmatched private-key opener through the final line", async () => {
    const { control } = recordingControl();
    const result = await redactMutationPresentationLines(
      ["prefix -----BEGIN PRIVATE KEY-----", "unclosed-private-material", "tail"],
      { control, maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES },
    );

    expect(result.redactionCount).toBe(1);
    expect(result.lines.map((line) => renderText(line.text))).toEqual([
      "prefix [redacted]",
      "",
      "",
    ]);
    expect(JSON.stringify(result)).not.toMatch(/unclosed-private-material|tail/u);
  });

  it("reports truncation when a typed redaction marker itself cannot fit", async () => {
    const { control } = recordingControl();
    const result = await redactMutationPresentationLines([OPENAI_SECRET], {
      control,
      maxRenderedBytesPerLine: 9,
    });

    expect(result.redactionCount).toBe(1);
    expect(result.lines[0]).toEqual({
      text: { segments: [], redactionCount: 0 },
      truncated: true,
    });
  });

  it("rejects invalid rendered-byte budgets without scanning producer content", async () => {
    for (const maxRenderedBytesPerLine of [
      -1,
      MUTATION_PRESENTATION_MAX_LINE_BYTES + 1,
      1.5,
      Number.NaN,
    ]) {
      const { control, work } = recordingControl();
      await expect(
        redactMutationPresentationLines([OPENAI_SECRET], {
          control,
          maxRenderedBytesPerLine,
        }),
      ).rejects.toThrow("mutation presentation construction budget exhausted");
      expect(work).toEqual([]);
    }
  });

  it("rejects oversized input shape before joining or scanning producer content", async () => {
    const oversizedInputs = [
      Array.from({ length: MUTATION_PRESENTATION_MAX_INDEXED_LINES + 1 }, () => ""),
      ["a".repeat(Math.floor(MUTATION_PRESENTATION_MAX_REDACTION_BYTE_VISITS / 3) + 1)],
    ];

    for (const lines of oversizedInputs) {
      const { control, work } = recordingControl();
      await expect(
        redactMutationPresentationLines(lines, {
          control,
          maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES,
        }),
      ).rejects.toThrow("mutation presentation construction budget exhausted");
      expect(work).toEqual([]);
    }
  });

  it("deduplicates one secret observed in adjacent overlap windows", async () => {
    const { control } = recordingControl();
    const input = `${"a".repeat(57_243)} ${OPENAI_SECRET} ${"b".repeat(3_000)}`;
    const result = await redactMutationPresentationLines([input], {
      control,
      maxRenderedBytesPerLine: 0,
    });

    expect(result.redactionCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(OPENAI_SECRET);
  });

  it("moves an overlap start off a split surrogate pair", async () => {
    const { control } = recordingControl();
    const input = `${"a".repeat(55_293)}🙂${"a".repeat(3_000)} ` + `${OPENAI_SECRET} tail`;
    const result = await redactMutationPresentationLines([input], {
      control,
      maxRenderedBytesPerLine: 0,
    });

    expect(result.redactionCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(OPENAI_SECRET);
  });

  it("returns one output record for every input line, including empty and fully redacted lines", async () => {
    const { control } = recordingControl();
    const result = await redactMutationPresentationLines(["", OPENAI_SECRET, "tail"], {
      control,
      maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES,
    });

    expect(result.lines).toHaveLength(3);
    expect(result.lines.map((line) => renderText(line.text))).toEqual(["", "[redacted]", "tail"]);
  });

  it("never materializes an unbounded control-expanded line before display truncation", async () => {
    const { control } = recordingControl();
    const observedByteLengthInputs: number[] = [];
    const originalByteLength = Buffer.byteLength.bind(Buffer);
    const byteLength = vi.spyOn(Buffer, "byteLength").mockImplementation((value, encoding) => {
      if (typeof value === "string") observedByteLengthInputs.push(value.length);
      return originalByteLength(value, encoding);
    });

    try {
      const result = await redactMutationPresentationLines(["\u009b".repeat(70 * 1024)], {
        control,
        maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES,
      });

      expect(result.lines[0]!.truncated).toBe(true);
      expect(Buffer.byteLength(renderText(result.lines[0]!.text), "utf8")).toBeLessThanOrEqual(
        MUTATION_PRESENTATION_MAX_LINE_BYTES,
      );
      expect(Math.max(...observedByteLengthInputs)).toBeLessThanOrEqual(
        MUTATION_PRESENTATION_YIELD_BYTE_WORK,
      );
    } finally {
      byteLength.mockRestore();
    }
  });

  it("fails closed before retaining more redaction metadata than the artifact can bound", async () => {
    let now = 0;
    const { control } = createMutationPresentationConstructionControl({
      startedAt: now,
      now: () => now,
      cooperativeYield: async () => {
        now += 0.001;
      },
      assertCurrent: () => undefined,
    });
    const credential = "x://u:p@h ";
    const input = credential.repeat(MUTATION_PRESENTATION_MAX_REDACTION_METADATA_RECORDS + 1);

    await expect(
      redactMutationPresentationLines([input], {
        control,
        maxRenderedBytesPerLine: MUTATION_PRESENTATION_MAX_LINE_BYTES,
      }),
    ).rejects.toThrow("mutation presentation construction budget exhausted");
  });
});
