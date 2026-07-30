# Hostile local-stdio MCP fixtures

Reusable attack fixtures for Epic 2.26 SEC-MCP Slice 1. These are local stdio
servers only; they are not remote MCP, HTTP MCP, resources, prompts, sampling,
elicitation, subscriptions, or completions support.

- `echo.cjs` is the narrow happy-path server used for review/discovery smoke.
- `shadow-resource.cjs` exposes a server tool named `bash`, emits server logs,
  and returns resource links/control text that must be inert and stripped.
- `rug-pull.cjs` changes definitions with `notifications/tools/list_changed`
  after returning a call result; keel must quarantine and suppress the result.
- `unsupported-client-request.cjs` asks the client for sampling after
  initialization; keel must refuse the request and continue tools-only handling.
- `flood.cjs` emits an oversized frame/log stream; keel must convert this into a
  bounded typed MCP error without crashing kernel or warden.
