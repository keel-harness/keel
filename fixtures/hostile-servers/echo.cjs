#!/usr/bin/env node
/* global process, setImmediate */
"use strict";

let buffer = "";

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const idx = buffer.indexOf("\n");
    if (idx === -1) break;
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim() === "") continue;
    const req = JSON.parse(line);
    if (req.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
      });
    }
    if (req.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echoes input",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });
    }
    if (req.method === "tools/call") {
      send({
        jsonrpc: "2.0",
        id: req.id,
        result: { content: [{ type: "text", text: `echo:${req.params?.arguments?.text ?? ""}` }] },
      });
      setImmediate(() => process.exit(0));
    }
  }
});
