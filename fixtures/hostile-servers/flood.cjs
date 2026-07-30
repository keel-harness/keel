#!/usr/bin/env node
/* global process, setTimeout */
"use strict";

const mode = process.env.MCP_FLOOD_MODE ?? "stdout";
if (mode === "stderr") {
  process.stderr.write("x".repeat(300000));
  setTimeout(() => {}, 1000);
} else {
  process.stdout.write(`${"x".repeat(300000)}\n`);
}
