import { createServer } from "node:http";

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

// Port 4111: free provider that is rate-limited (instant 429).
createServer((req, res) => {
  json(res, 429, { error: { message: "rate limit exceeded" } });
}).listen(4111);

// Port 4112: provider that hangs past the gateway timeout (forces abort).
createServer((req, res) => {
  setTimeout(() => json(res, 429, { error: { message: "late rate limit" } }), 800);
}).listen(4112);

// Port 4113: healthy provider echoing an OpenAI-shaped completion.
createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const parsed = JSON.parse(raw);
    const model = typeof parsed.model === "string" ? parsed.model : "unknown";
    json(res, 200, {
      id: "chatcmpl-solid",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: `served-by-solid:${model}` },
          finish_reason: "stop"
        }
      ],
      usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 }
    });
  });
}).listen(4113);

console.log("mock providers up on 4111 (429), 4112 (slow), 4113 (solid)");
