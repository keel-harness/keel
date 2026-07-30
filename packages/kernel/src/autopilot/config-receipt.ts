import {
  closeSync,
  chmodSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { oneLineText } from "../control-strip.js";
import { redactJsonLine } from "../secrets/redact.js";
import { keelHome } from "../session/paths.js";

const EXACT_EGRESS_DOMAIN_RE =
  /^(?:(?:[a-z1-9](?:[a-z0-9-]{0,61}[a-z0-9])?|0|0[a-wy-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?|0-(?:[a-z0-9-]{0,60}[a-z0-9]))\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const ConfigChangeTarget = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("autopilot-mode"),
      value: z.enum(["guided", "autopilot", "project-autopilot"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project-egress-domain"),
      value: z.string().min(1).max(253).regex(EXACT_EGRESS_DOMAIN_RE, "expected exact domain"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project-command-key"),
      value: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    })
    .strict(),
]);

export const ConfigChangeReceipt = z
  .object({
    type: z.literal("config_change"),
    v: z.literal(1),
    ts: z.string().datetime(),
    workspace: z.string().min(1),
    workspaceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    action: z.enum(["set", "clear", "revoke"]),
    target: ConfigChangeTarget,
    changed: z.string().min(1).max(512),
    verified: z.array(z.string().min(1).max(512)).min(1).max(8),
    notVerified: z.array(z.string().min(1).max(512)).max(8),
    undoCommand: z.string().min(1).max(512),
  })
  .strict()
  .superRefine((event, ctx) => {
    const modeTarget = event.target.kind === "autopilot-mode";
    if ((event.action === "set" || event.action === "clear") && !modeTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "set/clear receipts require an autopilot-mode target",
        path: ["target"],
      });
    }
    if (event.action === "revoke" && modeTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "revoke receipts require a grant target",
        path: ["target"],
      });
    }
    if (event.action === "clear" && modeTarget && event.target.value !== "guided") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "clear receipts require guided mode target",
        path: ["target", "value"],
      });
    }
  });

export type ConfigChangeReceiptT = z.infer<typeof ConfigChangeReceipt>;

export function configChangeReceiptFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(keelHome(env), "config-change-receipts.jsonl");
}

function writeLine(path: string, line: string): void {
  const fd = openSync(path, "a", 0o600);
  try {
    fchmodSync(fd, 0o600);
    const bytes = Buffer.from(line, "utf8");
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function appendConfigChangeReceipt(
  event: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const parsed = ConfigChangeReceipt.safeParse(event);
  if (!parsed.success) return false;
  try {
    const home = keelHome(env);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    const redacted = redactJsonLine(JSON.stringify(parsed.data));
    const redactedParsed = ConfigChangeReceipt.safeParse(JSON.parse(redacted));
    if (!redactedParsed.success) return false;
    const line = `${JSON.stringify(redactedParsed.data)}\n`;
    writeLine(configChangeReceiptFilePath(env), line);
    return true;
  } catch {
    return false;
  }
}

export function readConfigChangeReceipts(
  env: NodeJS.ProcessEnv = process.env,
): ConfigChangeReceiptT[] {
  const path = configChangeReceiptFilePath(env);
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  const endsWithNewline = content === "" || content.endsWith("\n");
  const raw = content.split("\n");
  const lines = endsWithNewline ? raw.slice(0, -1) : raw;
  const events: ConfigChangeReceiptT[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      if (!endsWithNewline && i === lines.length - 1) break;
      throw new Error(`corrupt config-change receipt line ${String(i)} in ${path}`);
    }
    const parsed = ConfigChangeReceipt.safeParse(value);
    if (!parsed.success) {
      throw new Error(`corrupt config-change receipt line ${String(i)} in ${path}`);
    }
    events.push(parsed.data);
  }
  return events;
}

function clean(value: string): string {
  return oneLineText(value);
}

function cleanList(values: readonly string[]): string {
  return values.map(clean).join("; ");
}

function redactReceiptText(value: string): string {
  try {
    const parsed: unknown = JSON.parse(redactJsonLine(JSON.stringify(value)));
    return typeof parsed === "string" ? parsed : "[redacted:invalid]";
  } catch {
    return "[redacted:invalid]";
  }
}

export function renderConfigChangeReceipt(event: ConfigChangeReceiptT): string {
  const lines = [
    "Config-change receipt",
    `changed: ${clean(event.changed)}`,
    `verified: ${cleanList(event.verified)}`,
  ];
  if (event.notVerified.length > 0) {
    lines.push(`not verified: ${cleanList(event.notVerified)}`);
  }
  lines.push(
    `undo: ${clean(event.undoCommand)}`,
    "record: keel-owned config-change journal; not a warden audit event",
  );
  return lines.join("\n");
}

export function renderConfigChangeReceiptAttempt(
  event: ConfigChangeReceiptT,
  options: { readonly recorded: boolean },
): string {
  if (options.recorded) return renderConfigChangeReceipt(event);
  return renderConfigChangeReceipt({
    ...event,
    changed: redactReceiptText(event.changed),
    verified: event.verified.map(redactReceiptText),
    notVerified: [
      ...event.notVerified.map(redactReceiptText),
      "config-change journal write failed",
    ],
    undoCommand: redactReceiptText(event.undoCommand),
  });
}

export function appendAndRenderConfigChangeReceipt(
  event: ConfigChangeReceiptT,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return renderConfigChangeReceiptAttempt(event, {
    recorded: appendConfigChangeReceipt(event, env),
  });
}

export function nowConfigReceiptTs(): string {
  return new Date().toISOString();
}
