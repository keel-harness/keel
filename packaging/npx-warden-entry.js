#!/usr/bin/env node
// Private npx Warden entry (ADR-0082). Install the exact bundled sandbox runtime before any Warden
// startup code can request it, then enter the unchanged stdio/MCP-discovery host.
const { importBundledVendoredSrtRuntime } =
  await import("../packages/warden/src/bundled-srt-runtime.js");
globalThis.__keelBundledSrtRuntime = await importBundledVendoredSrtRuntime();

await import("../packages/warden/src/bin-entry.ts");
