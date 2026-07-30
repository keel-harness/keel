import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { physicalRowCount } from "./row-budget.js";
import {
  assistantLivePreview,
  assistantLivePreviewNotice,
  assistantProseInline,
  assistantProsePlan,
  assistantProseRangePlan,
  assistantStreamingProjection,
  assistantStreamingCommitBoundary,
  assistantStreamingRangePlan,
  assistantStreamingSource,
  LIVE_ASSISTANT_PREVIEW_LINES,
  MAX_ATOMIC_STREAMING_ROWS,
  renderAssistantProsePlanText,
  renderAssistantProseText,
} from "./assistant-prose.js";

const ESC = String.fromCharCode(27);

const sample = [
  "I'm **keel** — a governance-native coding agent.",
  "",
  "## Core Capabilities",
  "",
  "**Read & understand code**",
  "- Explore the codebase",
  "- Trace dependencies",
  "",
  "```ts",
  "const ok = true;",
  "```",
  "",
  "---",
  "",
  "| Task | Examples |",
  "|---|---|",
  "| **Feature work** | Implement a spec'd feature |",
  "| **Bug fixing** | Write a regression test |",
].join("\n");

describe("assistant prose renderer plan", () => {
  it("parses the common assistant Markdown subset into terminal-native blocks", () => {
    const plan = assistantProsePlan(sample);
    expect(plan.blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "heading",
      "paragraph",
      "list",
      "code",
      "rule",
      "table",
    ]);
    expect(plan.blocks[1]).toMatchObject({ kind: "heading", level: 2 });
    expect(plan.blocks[3]).toMatchObject({
      kind: "list",
      items: [
        { marker: "bullet", text: [{ kind: "text", text: "Explore the codebase" }] },
        { marker: "bullet", text: [{ kind: "text", text: "Trace dependencies" }] },
      ],
    });
    expect(plan.blocks[4]).toMatchObject({
      kind: "code",
      language: "ts",
      lines: ["const ok = true;"],
    });
    expect(plan.blocks[6]).toMatchObject({
      kind: "table",
      headers: [[{ kind: "text", text: "Task" }], [{ kind: "text", text: "Examples" }]],
      rows: [
        [
          [{ kind: "strong", text: "Feature work" }],
          [{ kind: "text", text: "Implement a spec'd feature" }],
        ],
        [
          [{ kind: "strong", text: "Bug fixing" }],
          [{ kind: "text", text: "Write a regression test" }],
        ],
      ],
    });
  });

  it("renders deterministic plain text without raw Markdown scaffolding", () => {
    const text = renderAssistantProseText(sample);
    expect(text).toContain("I'm keel — a governance-native coding agent.");
    expect(text).toContain("Core Capabilities");
    expect(text).toContain("• Explore the codebase");
    expect(text).toContain("  const ok = true;");
    expect(text).toContain("Feature work — Examples: Implement a spec'd feature");
    expect(text).toContain("Bug fixing — Examples: Write a regression test");
    expect(text).not.toContain("##");
    expect(text).not.toContain("**");
    expect(text).not.toContain("```");
    expect(text).not.toContain("|---|");
    expect(text).not.toContain("---");
  });

  it("strips terminal control bytes before planning or rendering", () => {
    const text = renderAssistantProseText(`## ${ESC}[31mStatus${ESC}[0m\n\n- ok`);
    expect(text).toContain("Status");
    expect(text).toContain("• ok");
    expect(text).not.toContain(ESC);
  });

  it("makes default-ignorables explicit without damaging legitimate graphemes or layout", () => {
    const source =
      "before\u200Bsoft\u00ADword\u2060bom\uFEFFjoin\u200Dafter · 👩🏽‍💻 · 界 · e\u0301\tvalue";
    const settled = renderAssistantProseText(source);
    const streaming = assistantStreamingProjection(source, 160)
      .lines.map((line) => line.text)
      .join("\n");

    for (const rendered of [settled, streaming]) {
      expect(rendered).toContain(
        "before‹U+200B›soft‹U+00AD›word‹U+2060›bom‹U+FEFF›join‹U+200D›after",
      );
      expect(rendered).toContain("👩🏽‍💻 · 界 · e\u0301");
      expect(rendered).not.toContain("\t");
    }
    expect(settled).toContain("e\u0301 value");
    expect(streaming).toContain("e\u0301    value");
  });

  it("handles ordered lists, multiline paragraphs, unlabeled fences, and uneven tables", () => {
    const text = renderAssistantProseText(
      [
        "A long paragraph",
        "continues on the next line.",
        "",
        "1. First step",
        "2) Second step",
        "",
        "```",
        "plain code",
        "```",
        "",
        "Table intro",
        "| Name | Value |",
        "|---|---|",
        "| Alpha | |",
        "| Beta | |",
        "| | |",
        "| | value only |",
        "| Gamma | visible |",
      ].join("\n"),
    );

    expect(text).toContain("A long paragraph continues on the next line.");
    expect(text).toContain("1. First step");
    expect(text).toContain("2. Second step");
    expect(text).toContain("  plain code");
    expect(text).toContain("Table intro");
    expect(text).toContain("Alpha");
    expect(text).toContain("Beta");
    expect(text).toContain(" — Value: value only");
    expect(text).toContain("Gamma — Value: visible");
    expect(text).not.toContain("|---|");
  });

  it("wraps long streaming paragraphs without deleting or rewriting streamed source", () => {
    const plain = Array.from({ length: 36 }, (_, index) => `word-${index + 1}`).join(" ");
    const paragraph = `A **strong phrase with spaces** followed by ${plain}`;
    const wrapped = assistantStreamingSource(paragraph, 32);

    expect(wrapped.split("\n").length).toBeGreaterThan(8);
    expect(wrapped.split("\n").every((line) => stringWidth(line) <= 32)).toBe(true);
    expect(wrapped.replace(/\n/gu, "")).toBe(paragraph);
    const lines = wrapped.split("\n");
    for (let index = 0; index < lines.length - 1; index += 1) {
      expect(`${lines[index]?.at(-1) ?? ""}${lines[index + 1]?.at(0) ?? ""}`).toMatch(/\s/u);
    }
  });

  it("preserves code and shell punctuation in promoted streaming history", () => {
    const source = "if (a > b) return xs[0] | mask; const foo_bar = `cmd > output`;";
    const wrapped = assistantStreamingSource(source, 24);

    expect(wrapped.replace(/\n/gu, "")).toBe(source);
    expect(wrapped).toContain("(a > b)");
    expect(wrapped).toContain("|");
    expect(wrapped).toContain("foo_bar");
    expect(wrapped).toContain("`cmd > output`");
  });

  it("keeps promoted streaming prefixes stable when a late markdown delimiter arrives", () => {
    const words = Array.from({ length: 90 }, (_, index) => `token-${index + 1}`);
    const open = `**${words.slice(0, 70).join(" ")}`;
    const closed = `**${words.join(" ")}**`;
    const first = assistantStreamingSource(open, 32).split("\n");
    const final = assistantStreamingSource(closed, 32).split("\n");
    const committed = first.slice(0, -8);

    expect(committed.length).toBeGreaterThan(0);
    expect(final.slice(0, committed.length)).toEqual(committed);
    expect(first.join("\n").replace(/\n/gu, "")).toBe(open);
    expect(final.join("\n").replace(/\n/gu, "")).toBe(closed);
  });

  it("does not promote any physical row from an unfinished Markdown logical line", () => {
    const open = `**${"bold ".repeat(35)}`;
    const projection = assistantStreamingProjection(open, 38);

    expect(projection.totalLines).toBeGreaterThan(1);
    expect(assistantStreamingCommitBoundary(projection, projection.totalLines - 1)).toBe(0);
  });

  it("does not split a closed inline span across immutable and live render plans", () => {
    const source = `**${"bold word ".repeat(14)}** tail`;
    const projection = assistantStreamingProjection(source, 20);
    const boundary = assistantStreamingCommitBoundary(projection, 7);

    expect(projection.totalLines).toBeGreaterThan(7);
    expect(boundary).toBe(0);
    expect(renderAssistantProsePlanText(assistantStreamingRangePlan(projection, 0, boundary))).toBe(
      "",
    );
    expect(
      renderAssistantProsePlanText(
        assistantStreamingRangePlan(projection, 0, projection.totalLines),
      ),
    ).not.toContain("**");
  });

  it("holds a trailing logical line until late table syntax becomes stable", () => {
    const prefix = "A very long header name that wraps across several immutable rows before syntax";
    const suffix = " | Value\n--- | ---\nentry | visible";
    const first = assistantStreamingProjection(prefix, 20);
    const requested = first.totalLines - 1;
    const target = assistantStreamingCommitBoundary(first, requested);
    const incremental = assistantStreamingProjection(`${prefix}${suffix}`, 20, first, {
      retainFromLine: target,
      appended: suffix,
    });
    const cold = assistantStreamingProjection(`${prefix}${suffix}`, 20);

    expect(target).toBe(0);
    expect(assistantStreamingRangePlan(incremental, 0, incremental.totalLines)).toEqual(
      assistantStreamingRangePlan(cold, 0, cold.totalLines),
    );
    expect(assistantStreamingRangePlan(cold, 0, cold.totalLines).blocks[0]).toMatchObject({
      kind: "table",
      headers: [[{ kind: "text", text: prefix }], [{ kind: "text", text: "Value" }]],
    });
  });

  it("degrades an adversarial no-newline inline span to bounded literal streaming work", () => {
    let input = "**";
    let projection = assistantStreamingProjection(input, 20);
    for (let index = 0; index < 200; index += 1) {
      const appended = "x".repeat(40);
      input += appended;
      const target = assistantStreamingCommitBoundary(
        projection,
        Math.max(0, projection.totalLines - 1),
      );
      projection = assistantStreamingProjection(input, 20, projection, {
        retainFromLine: target,
        appended,
      });
    }

    expect(projection.lines.length).toBeLessThanOrEqual(MAX_ATOMIC_STREAMING_ROWS + 2);
    expect(projection.source.length).toBeLessThan(300);
    expect(projection.lines.every((line) => line.literal)).toBe(true);
  });

  it("physically bounds code fences, list items, tables, and unbroken tokens", () => {
    const token = "x".repeat(80);
    const structured = [`- ${token}`, "```", token, "```", `| ${token} | value |`, token].join(
      "\n",
    );

    const lines = assistantStreamingSource(structured, 32).split("\n");
    expect(lines.length).toBeGreaterThan(8);
    expect(lines.every((line) => stringWidth(line) <= 32)).toBe(true);
    expect(lines.join("\n").replace(/\n/gu, "")).toBe(structured.replace(/\n/gu, ""));
  });

  it("does not insert spaces into a hard-wrapped URL when promoted prose is rendered", () => {
    const url = `https://example.test/${"immutable-segment".repeat(8)}?sha=${"a".repeat(64)}`;
    const projection = assistantStreamingProjection(url, 24);
    const rendered = renderAssistantProsePlanText(
      assistantStreamingRangePlan(projection, 0, projection.lines.length),
    );

    expect(rendered).toBe(url);
  });

  it("append-extends a streaming projection without rebuilding stable prefix lines", () => {
    const first = assistantStreamingProjection(`${"word ".repeat(80)}tail`, 32);
    const extended = assistantStreamingProjection(`${first.source} plus more words`, 32, first);

    expect(extended.lines.slice(0, -2)).toEqual(first.lines.slice(0, -2));
    expect(
      extended.lines
        .map((line) => line.text)
        .join("")
        .replace(/\n/gu, ""),
    ).toBe(`${first.source} plus more words`.replace(/\n/gu, ""));
  });

  it("keeps soft-wrapped fence metadata invariant across append chunks", () => {
    const opening = "```ts annotation annotation";
    const first = assistantStreamingProjection(opening, 20);
    const input = `${opening}\nconst ok = true;\n\`\`\``;

    const incremental = assistantStreamingProjection(input, 20, first);
    const cold = assistantStreamingProjection(input, 20);

    expect(incremental).toEqual(cold);
    expect(
      cold.lines.map(({ syntax, fenceOpenBefore, language }) => ({
        syntax,
        fenceOpenBefore,
        language,
      })),
    ).toEqual([
      { syntax: "fence", fenceOpenBefore: false, language: "ts" },
      { syntax: "fence", fenceOpenBefore: false, language: "ts" },
      { syntax: "code", fenceOpenBefore: true, language: "ts" },
      { syntax: "fence", fenceOpenBefore: true, language: "ts" },
    ]);
  });

  it("reclassifies an opening fence split across provider deltas", () => {
    let input = "";
    let projection = assistantStreamingProjection(input, 40);
    for (const chunk of ["`", "`", "`", "ts", "\n", "const ok = true;", "\n", "```"]) {
      input += chunk;
      projection = assistantStreamingProjection(input, 40, projection, { appended: chunk });
      expect(projection.lines).toEqual(assistantStreamingProjection(input, 40).lines);
    }
  });

  it("matches cold projection at every split boundary for structured and Unicode streams", () => {
    const samples = [
      "before\n```ts annotation annotation\nconst value = 1;\n```\nafter",
      "alpha\tbeta\t界\nnext\trow",
      "combining e\u0301 and flags 🇺🇸 beside text",
      "family 👨\u200d👩\u200d👧\u200d👦 after a narrow wrap boundary",
      "| name | result |\n| --- | --- |\n| build | passed |",
    ] as const;

    for (const source of samples) {
      for (const width of [12, 20, 40]) {
        const cold = assistantStreamingProjection(source, width);
        for (let split = 0; split <= source.length; split += 1) {
          const prefix = source.slice(0, split);
          const suffix = source.slice(split);
          const first = assistantStreamingProjection(prefix, width);
          expect(assistantStreamingProjection(source, width, first, { appended: suffix })).toEqual(
            cold,
          );
        }

        let streamed = "";
        let incremental = assistantStreamingProjection(streamed, width);
        for (const codeUnit of source.split("")) {
          streamed += codeUnit;
          incremental = assistantStreamingProjection(streamed, width, incremental, {
            appended: codeUnit,
          });
          expect(incremental).toEqual(assistantStreamingProjection(streamed, width));
        }
      }
    }
  });

  it("reprojects a prior row when an appended ZWJ grapheme collapses in width", () => {
    const chunks = ["alpha beta gamma 👨", "\u200d", "👩", "\u200d", "👧"];
    let input = "";
    let incremental = assistantStreamingProjection(input, 20);

    for (const chunk of chunks) {
      input += chunk;
      incremental = assistantStreamingProjection(input, 20, incremental);
      expect(incremental).toEqual(assistantStreamingProjection(input, 20));
    }

    expect(incremental.lines.map((line) => line.text)).toEqual([input]);
  });

  it("expands tabs consistently when an appended grapheme makes a line non-ASCII", () => {
    const ascii = "a\t".repeat(12);
    const first = assistantStreamingProjection(ascii, 20);
    const input = `${ascii}界`;

    const incremental = assistantStreamingProjection(input, 20, first);
    const cold = assistantStreamingProjection(input, 20);

    expect(incremental).toEqual(cold);
    expect(cold.lines.every((line) => !line.text.includes("\t"))).toBe(true);
    expect(
      cold.lines
        .map((line) => line.text)
        .join("")
        .replaceAll(" ", ""),
    ).toBe(input.replaceAll("\t", ""));
  });

  it("keeps reducer-proven append state bounded independently of streamed history", () => {
    const project = (count: number) => {
      let input = "";
      let projection = assistantStreamingProjection(input, 40);
      for (let index = 0; index < count; index += 1) {
        const chunk = `${index % 10}abc`;
        input += chunk;
        projection = assistantStreamingProjection(input, 40, projection, {
          retainFromLine: Math.max(0, projection.totalLines - LIVE_ASSISTANT_PREVIEW_LINES),
          appended: chunk,
        });
      }
      return projection;
    };

    const short = project(4_000);
    const long = project(8_000);
    expect(long.input).toHaveLength(32_000);
    expect(long.lines.length).toBeLessThanOrEqual(LIVE_ASSISTANT_PREVIEW_LINES + 2);
    expect(long.source.length).toBeLessThan(1_000);
    expect(long.source.length).toBeLessThan(short.source.length * 2 + 80);
    expect(long.sourceOffset).toBeGreaterThan(20_000);
  });

  it("releases rows already owned by Static while retaining absolute line indexes", () => {
    const source = Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join("\n");
    const first = assistantStreamingProjection(source, 80);
    const retainFromLine = first.lines.length - LIVE_ASSISTANT_PREVIEW_LINES;
    const input = `${source} tail`;

    const retained = assistantStreamingProjection(input, 80, first, { retainFromLine });
    const cold = assistantStreamingProjection(input, 80);

    expect(retained.totalLines).toBe(cold.lines.length);
    expect(retained.lineOffset).toBeGreaterThanOrEqual(retainFromLine - 2);
    expect(retained.lines.length).toBeLessThanOrEqual(LIVE_ASSISTANT_PREVIEW_LINES + 2);
    expect(retained.lines).toEqual(cold.lines.slice(retained.lineOffset));
  });

  it("keeps repeated 100k ASCII append projection structurally bounded", () => {
    let input = "";
    let projection = assistantStreamingProjection(input, 80);
    for (let index = 0; index < 200; index += 1) {
      const chunk = `${"segment ".repeat(62)}${String(index).padStart(4, "0")}\n`;
      input += chunk;
      projection = assistantStreamingProjection(input, 80, projection, {
        retainFromLine: Math.max(0, projection.totalLines - LIVE_ASSISTANT_PREVIEW_LINES),
        appended: chunk,
      });
    }

    expect(projection.input.length).toBeGreaterThan(100_000);
    expect(projection.source.length).toBeLessThan(2_000);
    // One provider delta may itself emit several rows; retained history stays bounded separately.
    expect(projection.lines.length).toBeLessThanOrEqual(LIVE_ASSISTANT_PREVIEW_LINES + 10);
  });

  it("expands tabs to deterministic spaces while retaining raw source separately", () => {
    const source = "\t".repeat(12);
    const projection = assistantStreamingProjection(source, 20);
    const projected = projection.lines.map((line) => line.text).join("\n");

    expect(projection.source).toBe(source);
    expect(projected).not.toContain("\t");
    expect(projected.replace(/\n/gu, "")).toBe(" ".repeat(48));
    expect(physicalRowCount(projected, 20)).toBe(projected.split("\n").length);
    expect(projected.split("\n").length).toBeGreaterThan(1);
    expect(renderAssistantProseText("text\tvalue\n\n```sh\n\tprintf ok\n```")).not.toContain("\t");
  });

  it("rechecks width after a soft wrap leaves text before a tab", () => {
    const projected = assistantStreamingSource(`a ${"x".repeat(18)}\t`, 20);

    expect(projected.split("\n").every((line) => stringWidth(line) <= 20)).toBe(true);
    expect(projected).not.toContain("\t");
    expect(projected.replace(/\n/gu, "")).toBe(`a ${"x".repeat(18)}    `);
  });

  it("plans only the selected streaming rows while retaining code-fence context", () => {
    const source = `${Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join("\n")}\n\n\`\`\`ts\nconst one = 1;\nconst two = 2;\n\`\`\``;
    const projection = assistantStreamingProjection(source, 80);
    let indexedReads = 0;
    const lines = new Proxy(projection.lines, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/u.test(property)) indexedReads += 1;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const start = projection.lines.length - 3;
    const plan = assistantStreamingRangePlan({ ...projection, lines }, start, start + 2);

    expect(plan.blocks).toEqual([
      { kind: "code", language: "ts", lines: ["const one = 1;", "const two = 2;"] },
    ]);
    expect(indexedReads).toBeLessThanOrEqual(4);
  });

  it("handles inline code, underscore emphasis, and unclosed markers", () => {
    expect(assistantProseInline("__bold__ and `code`")).toEqual([
      { kind: "strong", text: "bold" },
      { kind: "text", text: " and " },
      { kind: "code", text: "code" },
    ]);
    expect(assistantProseInline("literal ** marker")).toEqual([
      { kind: "text", text: "literal ** marker" },
    ]);
  });

  it("renders single-marker emphasis without consuming identifiers or unmatched markers", () => {
    expect(
      assistantProseInline("the model may only *request* actions and _never_ approve them"),
    ).toEqual([
      { kind: "text", text: "the model may only " },
      { kind: "emphasis", text: "request" },
      { kind: "text", text: " actions and " },
      { kind: "emphasis", text: "never" },
      { kind: "text", text: " approve them" },
    ]);
    expect(assistantProseInline("snake_case and an unmatched * marker")).toEqual([
      { kind: "text", text: "snake_case and an unmatched * marker" },
    ]);
    expect(renderAssistantProseText("The model can only *request* actions.")).toBe(
      "The model can only request actions.",
    );
  });

  it("keeps a wrapped real-model list item atomic so inline code cannot pair across tokens", () => {
    const source =
      "- **Verified:** Ran `node --test test/math.test.js` (the exact command `pnpm test` delegates to); both tests pass — `add returns the sum` ✅ and `subtract returns the difference` ✅.";
    const projection = assistantStreamingProjection(source, 78);
    const middle = Math.floor(projection.lines.length / 2);
    const plan = assistantStreamingRangePlan(projection, 0, projection.totalLines);
    const rendered = renderAssistantProsePlanText(plan);

    expect(projection.lines.length).toBeGreaterThan(1);
    expect(assistantStreamingCommitBoundary(projection, middle)).toBe(0);
    expect(plan.blocks).toEqual([
      {
        kind: "list",
        items: [
          {
            marker: "bullet",
            text: [
              { kind: "strong", text: "Verified:" },
              { kind: "text", text: " Ran " },
              { kind: "code", text: "node --test test/math.test.js" },
              { kind: "text", text: " (the exact command " },
              { kind: "code", text: "pnpm test" },
              { kind: "text", text: " delegates to); both tests pass — " },
              { kind: "code", text: "add returns the sum" },
              { kind: "text", text: " ✅ and " },
              { kind: "code", text: "subtract returns the difference" },
              { kind: "text", text: " ✅." },
            ],
          },
        ],
      },
    ]);
    expect(rendered).toContain("• Verified: Ran node --test test/math.test.js");
    expect(rendered).not.toContain("`");
  });

  it("carries semantic spacing across immutable streaming ranges", () => {
    const projection = assistantStreamingProjection(
      ["Intro.", "", "### Core idea", "", "Body.", "", "- one", "- two"].join("\n"),
      80,
    );

    expect(assistantStreamingRangePlan(projection, 2, 5).spacing).toEqual(["section", "tight"]);
    expect(assistantStreamingRangePlan(projection, 4, 5).spacing).toEqual(["tight"]);
    expect(assistantStreamingRangePlan(projection, 7, 8).spacing).toEqual(["tight"]);
  });

  it("renders table values even when a header cell is blank", () => {
    const text = renderAssistantProseText("| Name | |\n|---|---|\n| Alpha | unlabeled value |");
    expect(text).toContain("Alpha — unlabeled value");
  });

  it("does not generate Phase-2 enforcement or autonomy language of its own", () => {
    const text = renderAssistantProseText("## Capabilities\n\n- Read files\n- Run tests");
    expect(text).not.toMatch(/approved|sandboxed|policy cleared|audit verified|trusted|autopilot/i);
  });

  it("bounds live streaming prose to a stable tail preview with an honest hidden-line notice", () => {
    const preview = assistantLivePreview(
      Array.from({ length: 12 }, (_, i) => `row ${String(i + 1).padStart(2, "0")}`).join("\n"),
      8,
    );

    expect(preview.hiddenLines).toBe(4);
    expect(preview.content).toContain("row 05");
    expect(preview.content).toContain("row 12");
    expect(preview.content).not.toContain("row 01");
    expect(assistantLivePreviewNotice(preview.hiddenLines)).toBe(
      "… 4 earlier live lines hidden until turn finishes",
    );
    expect(assistantLivePreviewNotice(1)).toBe("… 1 earlier live line hidden until turn finishes");
  });

  it("rejects attempts to re-plan streaming rows already owned by terminal history", () => {
    const full = assistantStreamingProjection(`${"stable row\n".repeat(8)}live tail`, 80);
    const retained = assistantStreamingProjection(`${full.input} extended`, 80, full, {
      retainFromLine: 6,
      appended: " extended",
    });

    expect(retained.lineOffset).toBeGreaterThan(0);
    expect(() => assistantStreamingRangePlan(retained, 0, retained.totalLines)).toThrow(
      new RangeError(
        `streaming rows before ${retained.lineOffset} are already owned by terminal history`,
      ),
    );
  });

  it("preserves fenced-code context when an immutable chunk starts inside the fence", () => {
    const source = [
      "before",
      "```ts",
      "const one = 1;",
      "const two = 2;",
      "const three = 3;",
      "```",
      "after",
    ].join("\n");

    expect(assistantProseRangePlan(source, 3, 7).blocks).toEqual([
      { kind: "code", language: "ts", lines: ["const two = 2;", "const three = 3;"] },
      { kind: "paragraph", text: [{ kind: "text", text: "after" }] },
    ]);
  });

  it("preserves table headers when an immutable chunk starts on later rows", () => {
    const source = [
      "| Name | Value |",
      "|---|---|",
      "| Alpha | one |",
      "| Beta | two |",
      "| Gamma | three |",
    ].join("\n");
    const blocks = assistantProseRangePlan(source, 3, 5).blocks;

    expect(blocks).toEqual([
      {
        kind: "table",
        headers: [[{ kind: "text", text: "Name" }], [{ kind: "text", text: "Value" }]],
        rows: [
          [[{ kind: "text", text: "Beta" }], [{ kind: "text", text: "two" }]],
          [[{ kind: "text", text: "Gamma" }], [{ kind: "text", text: "three" }]],
        ],
      },
    ]);
  });
});
