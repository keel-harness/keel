import { appendFileSync } from "node:fs";
import http from "node:http";
import process from "node:process";

const port = Number(process.argv[2] ?? 0);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("usage: node pty-loopback-fixture.mjs <port>");
}

function event(model, content, finishReason = null) {
  return {
    id: "chatcmpl-keel-installed-pty-smoke",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [
      { index: 0, delta: content === undefined ? {} : { content }, finish_reason: finishReason },
    ],
  };
}

function writeEvent(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function messageText(message) {
  if (message === null || typeof message !== "object") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) =>
      part !== null && typeof part === "object" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

function hasUserMarker(messages, marker) {
  return (
    Array.isArray(messages) &&
    messages.some(
      (message) =>
        message !== null &&
        typeof message === "object" &&
        message.role === "user" &&
        messageText(message).includes(marker),
    )
  );
}

function hasToolResult(messages, toolCallId) {
  return (
    Array.isArray(messages) &&
    messages.some(
      (message) =>
        message !== null &&
        typeof message === "object" &&
        message.role === "tool" &&
        message.tool_call_id === toolCallId,
    )
  );
}

function streamToolCall(response, model, toolCallId, name, args) {
  writeEvent(response, {
    ...event(model, ""),
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });
  writeEvent(response, {
    ...event(model, ""),
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  writeEvent(response, {
    ...event(model, undefined, "tool_calls"),
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

function streamSettlement(response, model, marker) {
  writeEvent(response, {
    ...event(model, ""),
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });
  writeEvent(response, event(model, `${marker}\n`));
  writeEvent(response, event(model, undefined, "stop"));
  response.write("data: [DONE]\n\n");
  response.end();
}

const server = http.createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      response.writeHead(400).end();
      return;
    }
    const requestLog = process.env.KEEL_FIXTURE_REQUEST_LOG;
    if (requestLog) appendFileSync(requestLog, "1\n", { encoding: "utf8" });
    const model = typeof parsed?.model === "string" ? parsed.model : "";
    const urgent = /^urgent-(now|before-next-edit|stop-after-current)-(KSTR\d{4})$/u.exec(model);
    if (urgent === null) {
      response.writeHead(400).end();
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close",
    });
    const nonce = urgent[2];
    const readId = `${nonce}-read-1`;
    if (hasUserMarker(parsed?.messages, `${nonce}-ORDINARY`)) {
      streamSettlement(response, model, `${nonce}-ORDINARY-DONE`);
    } else if (hasUserMarker(parsed?.messages, `${nonce}-URGENT-APPLIED`)) {
      streamSettlement(response, model, `${nonce}-REDRIVE-DONE`);
    } else if (hasToolResult(parsed?.messages, readId)) {
      streamToolCall(response, model, `${nonce}-edit-1`, "edit", {
        path: "target.txt",
        oldString: "before\n",
        newString: "after\n",
      });
    } else {
      streamToolCall(response, model, readId, "read", { path: "gate.pipe" });
    }
  });
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
