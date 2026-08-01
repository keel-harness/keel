import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildSandboxCommand } from "../../src/sandbox/linux-sandbox-utils.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const FAIL_CLOSED_PROCESS_TIMEOUT_MS = 15_000;
const FAIL_CLOSED_MAX_ELAPSED_MS = 12_000;
const FAIL_CLOSED_TEST_TIMEOUT_MS = 20_000;

function createFixture(mode: "delayed-ready" | "socks-never-ready"): {
  directory: string;
  socatPath: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "keel-srt-readiness-"));
  temporaryDirectories.push(directory);
  const socatPath = join(directory, "socat");
  const listenerBody =
    mode === "delayed-ready"
      ? 'sleep 0.25\n: > "$KEEL_SRT_TEST_DIR/$port.ready"'
      : 'if [ "$port" -eq 3128 ]; then : > "$KEEL_SRT_TEST_DIR/$port.ready"; fi';

  writeFileSync(
    socatPath,
    `#!/bin/sh
case "$*" in
  *TCP-LISTEN:3128*) port=3128 ;;
  *TCP-LISTEN:1080*) port=1080 ;;
  *TCP:127.0.0.1:3128*) test -f "$KEEL_SRT_TEST_DIR/3128.ready"; exit ;;
  *TCP:127.0.0.1:1080*) test -f "$KEEL_SRT_TEST_DIR/1080.ready"; exit ;;
  *) exit 2 ;;
esac
${listenerBody}
trap 'exit 0' TERM INT
while :; do sleep 1; done
`,
  );
  chmodSync(socatPath, 0o755);

  return { directory, socatPath };
}

function commandFor(socatPath: string, userCommand: string): string {
  return buildSandboxCommand(
    "/tmp/keel-http.sock",
    "/tmp/keel-socks.sock",
    userCommand,
    undefined,
    "/bin/sh",
    socatPath,
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Linux sandbox proxy readiness", () => {
  it("waits for both sandbox-local proxy listeners before starting the governed command", async () => {
    const fixture = createFixture("delayed-ready");

    const result = await execFileAsync(
      "/bin/sh",
      [
        "-c",
        commandFor(
          fixture.socatPath,
          'test -f "$KEEL_SRT_TEST_DIR/3128.ready" && test -f "$KEEL_SRT_TEST_DIR/1080.ready" && printf "governed-command-started\\n"',
        ),
      ],
      {
        env: { ...process.env, KEEL_SRT_TEST_DIR: fixture.directory },
        timeout: 10_000,
      },
    );

    expect(result.stdout).toBe("governed-command-started\n");
    expect(result.stderr).toBe("");
  });

  it("fails closed within a bounded interval when a proxy listener never becomes ready", async () => {
    const fixture = createFixture("socks-never-ready");
    const startedMarker = join(fixture.directory, "governed-command-started");
    const startedAt = performance.now();

    await expect(
      execFileAsync("/bin/sh", ["-c", commandFor(fixture.socatPath, `: > '${startedMarker}'`)], {
        env: { ...process.env, KEEL_SRT_TEST_DIR: fixture.directory },
        timeout: FAIL_CLOSED_PROCESS_TIMEOUT_MS,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "sandbox proxy listener on 127.0.0.1:1080 did not become ready",
      ),
    });

    expect(performance.now() - startedAt).toBeLessThan(FAIL_CLOSED_MAX_ELAPSED_MS);
    expect(existsSync(startedMarker)).toBe(false);
  }, FAIL_CLOSED_TEST_TIMEOUT_MS);
});
