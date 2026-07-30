import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendAndRenderConfigChangeReceipt,
  appendConfigChangeReceipt,
  configChangeReceiptFilePath,
  readConfigChangeReceipts,
  renderConfigChangeReceipt,
} from "./config-receipt.js";

describe("Autopilot config-change receipts", () => {
  it("persists a keel-owned config-change journal entry and renders changed/verified/undo lines", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-config-receipt-"));
    const env = { KEEL_HOME: keelHome };
    try {
      const event = {
        type: "config_change" as const,
        v: 1 as const,
        ts: "2026-07-07T00:00:00.000Z",
        workspace: "/repo",
        action: "set" as const,
        target: { kind: "autopilot-mode" as const, value: "project-autopilot" as const },
        changed: "Autopilot mode: Project Autopilot",
        verified: ["stored in keel-owned user config"],
        notVerified: ["live warden mode.change has not run yet"],
        undoCommand: "keel autopilot mode clear",
      };

      expect(appendConfigChangeReceipt(event, env)).toBe(true);
      expect(readConfigChangeReceipts(env)).toEqual([event]);
      expect(renderConfigChangeReceipt(event)).toBe(
        [
          "Config-change receipt",
          "changed: Autopilot mode: Project Autopilot",
          "verified: stored in keel-owned user config",
          "not verified: live warden mode.change has not run yet",
          "undo: keel autopilot mode clear",
          "record: keel-owned config-change journal; not a warden audit event",
        ].join("\n"),
      );
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
    }
  });

  it("rejects malformed receipt authority fields instead of journaling ambiguous changes", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-config-receipt-bad-"));
    const env = { KEEL_HOME: keelHome };
    try {
      expect(
        appendConfigChangeReceipt(
          {
            type: "config_change",
            v: 1,
            ts: "2026-07-07T00:00:00.000Z",
            workspace: "/repo",
            action: "revoke",
            target: { kind: "project-command-key", value: "mkdir dist" },
            changed: "Project command grant revoked",
            verified: ["removed from keel-owned user config"],
            notVerified: [],
            undoCommand: "approve the same command review again",
          },
          env,
        ),
      ).toBe(false);
      expect(
        appendConfigChangeReceipt(
          {
            type: "config_change",
            v: 1,
            ts: "2026-07-07T00:00:00.000Z",
            workspace: "/repo",
            workspaceHash: "not-a-sha",
            action: "revoke",
            target: { kind: "project-egress-domain", value: "example.com" },
            changed: "Project egress grant revoked: example.com",
            verified: ["removed from keel-owned user config"],
            notVerified: [],
            undoCommand: "approve egress to example.com again when a live review asks",
          },
          env,
        ),
      ).toBe(false);
      expect(
        appendConfigChangeReceipt(
          {
            type: "config_change",
            v: 1,
            ts: "2026-07-07T00:00:00.000Z",
            workspace: "/repo",
            workspaceHash: "a".repeat(64),
            action: "set",
            target: { kind: "project-egress-domain", value: "example.com" },
            changed: "Project egress grant revoked: example.com",
            verified: ["removed from keel-owned user config"],
            notVerified: [],
            undoCommand: "approve egress to example.com again when a live review asks",
          },
          env,
        ),
      ).toBe(false);
      expect(
        appendConfigChangeReceipt(
          {
            type: "config_change",
            v: 1,
            ts: "2026-07-07T00:00:00.000Z",
            workspace: "/repo",
            workspaceHash: "a".repeat(64),
            action: "clear",
            target: { kind: "autopilot-mode", value: "project-autopilot" },
            changed: "Autopilot mode: Project Autopilot",
            verified: ["removed persisted mode from keel-owned user config"],
            notVerified: [],
            undoCommand: "keel autopilot mode set autopilot",
          },
          env,
        ),
      ).toBe(false);
      expect(readConfigChangeReceipts(env)).toEqual([]);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
    }
  });

  it("does not report success when redaction would corrupt a structured authority field", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-config-receipt-redaction-"));
    const env = { KEEL_HOME: keelHome };
    try {
      expect(
        appendConfigChangeReceipt(
          {
            type: "config_change",
            v: 1,
            ts: "2026-07-07T00:00:00.000Z",
            workspace: "/repo",
            workspaceHash: "a".repeat(64),
            action: "revoke",
            target: {
              kind: "project-egress-domain",
              value: "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa.example.com",
            },
            changed: "Project egress grant revoked: sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa.example.com",
            verified: ["removed from keel-owned user config"],
            notVerified: [],
            undoCommand:
              "approve egress to sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa.example.com again when a live review asks",
          },
          env,
        ),
      ).toBe(false);
      expect(readConfigChangeReceipts(env)).toEqual([]);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
    }
  });

  it("redacts fallback receipt output when a structured authority field prevents journaling", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-config-receipt-redaction-fallback-"));
    const env = { KEEL_HOME: keelHome };
    try {
      const output = appendAndRenderConfigChangeReceipt(
        {
          type: "config_change",
          v: 1,
          ts: "2026-07-07T00:00:00.000Z",
          workspace: "/repo",
          workspaceHash: "a".repeat(64),
          action: "revoke",
          target: {
            kind: "project-egress-domain",
            value: "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa.example.com",
          },
          changed: "Project egress grant revoked: sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa.example.com",
          verified: ["removed from keel-owned user config"],
          notVerified: [],
          undoCommand:
            "approve egress to sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa.example.com again when a live review asks",
        },
        env,
      );

      expect(output).toContain("Config-change receipt");
      expect(output).toContain("[redacted:anthropic-key]");
      expect(output).not.toContain("sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa");
      expect(output).toContain("config-change journal write failed");
      expect(readConfigChangeReceipts(env)).toEqual([]);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
    }
  });

  it("keeps valid entries readable when the final journal line is torn", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-config-receipt-torn-"));
    const env = { KEEL_HOME: keelHome };
    try {
      expect(
        appendConfigChangeReceipt(
          {
            type: "config_change",
            v: 1,
            ts: "2026-07-07T00:00:00.000Z",
            workspace: "/repo",
            workspaceHash: "b".repeat(64),
            action: "revoke",
            target: { kind: "project-egress-domain", value: "example.com" },
            changed: "Project egress grant revoked: example.com",
            verified: ["removed from keel-owned user config"],
            notVerified: ["already-running warden sessions were not changed"],
            undoCommand: "approve egress to example.com again when a live review asks",
          },
          env,
        ),
      ).toBe(true);
      appendFileSync(
        join(keelHome, "config-change-receipts.jsonl"),
        '{"type":"config_change","v":1',
      );

      expect(readConfigChangeReceipts(env)).toHaveLength(1);
      expect(readConfigChangeReceipts(env)[0]).toMatchObject({
        workspaceHash: "b".repeat(64),
        target: { kind: "project-egress-domain", value: "example.com" },
      });
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
    }
  });

  it("fails loudly on corrupt non-final journal lines", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-config-receipt-corrupt-"));
    const env = { KEEL_HOME: keelHome };
    try {
      expect(
        appendConfigChangeReceipt(
          {
            type: "config_change",
            v: 1,
            ts: "2026-07-07T00:00:00.000Z",
            workspace: "/repo",
            action: "revoke",
            target: { kind: "project-egress-domain", value: "example.com" },
            changed: "Project egress grant revoked: example.com",
            verified: ["removed from keel-owned user config"],
            notVerified: [],
            undoCommand: "approve egress to example.com again when a live review asks",
          },
          env,
        ),
      ).toBe(true);
      appendFileSync(
        configChangeReceiptFilePath(env),
        '{"type":"config_change","v":1\n{"type":"config_change"}\n',
      );

      expect(() => readConfigChangeReceipts(env)).toThrow(/corrupt config-change receipt line 1/);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
    }
  });

  it("fails loudly on schema-invalid JSONL receipt lines", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-config-receipt-invalid-schema-"));
    const env = { KEEL_HOME: keelHome };
    try {
      mkdirSync(keelHome, { recursive: true });
      writeFileSync(configChangeReceiptFilePath(env), '{"type":"config_change","v":1}\n');

      expect(() => readConfigChangeReceipts(env)).toThrow(/corrupt config-change receipt line 0/);
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
    }
  });

  it("repairs loose receipt directory and file permissions before appending", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-config-receipt-mode-"));
    const env = { KEEL_HOME: keelHome };
    try {
      writeFileSync(configChangeReceiptFilePath(env), "");
      chmodSync(keelHome, 0o777);
      chmodSync(configChangeReceiptFilePath(env), 0o666);

      expect(
        appendConfigChangeReceipt(
          {
            type: "config_change",
            v: 1,
            ts: "2026-07-07T00:00:00.000Z",
            workspace: "/repo",
            action: "set",
            target: { kind: "autopilot-mode", value: "autopilot" },
            changed: "Autopilot mode: Autopilot",
            verified: ["stored in keel-owned user config"],
            notVerified: [],
            undoCommand: "keel autopilot mode clear",
          },
          env,
        ),
      ).toBe(true);

      expect(statSync(keelHome).mode & 0o777).toBe(0o700);
      expect(statSync(configChangeReceiptFilePath(env)).mode & 0o777).toBe(0o600);
    } finally {
      chmodSync(keelHome, 0o700);
      rmSync(keelHome, { recursive: true, force: true });
    }
  });

  it("renders known change and undo guidance when the journal append fails", () => {
    const keelHome = mkdtempSync(join(tmpdir(), "keel-config-receipt-fallback-"));
    const env = { KEEL_HOME: keelHome };
    try {
      mkdirSync(configChangeReceiptFilePath(env), { recursive: true });

      const output = appendAndRenderConfigChangeReceipt(
        {
          type: "config_change",
          v: 1,
          ts: "2026-07-07T00:00:00.000Z",
          workspace: "/repo",
          action: "set",
          target: { kind: "autopilot-mode", value: "autopilot" },
          changed: "Autopilot mode: Autopilot",
          verified: ["stored in keel-owned user config"],
          notVerified: ["live warden mode.change has not run yet"],
          undoCommand: "keel autopilot mode clear",
        },
        env,
      );

      expect(output).toContain("changed: Autopilot mode: Autopilot");
      expect(output).toContain("verified: stored in keel-owned user config");
      expect(output).toContain("not verified: live warden mode.change has not run yet");
      expect(output).toContain("config-change journal write failed");
      expect(output).toContain("undo: keel autopilot mode clear");
      expect(output).toContain("not a warden audit event");
    } finally {
      rmSync(keelHome, { recursive: true, force: true });
    }
  });
});
