import { WebSocket } from "ws";

const PULSE = "http://127.0.0.1:4001";
const BRIDGE_WS = "ws://127.0.0.1:4000/ws";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failures++;
};

const frames = [];
const ws = new WebSocket(BRIDGE_WS);
ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
await sleep(300);

const bridgeBefore = (await (await fetch("http://127.0.0.1:4000/health")).json()).eventsRelayed;

async function chat(body, headers = {}) {
  const res = await fetch(PULSE + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}
const msg = (content) => [{ role: "user", content }];

// 1. Health
let health = await (await fetch(PULSE + "/health")).json();
check("health ok", health.status === "ok");
check("three providers configured", health.providers.length === 3, health.providers.join(","));
check("bridge link connected", health.bridge?.connected === true);

// 2. Models aggregation
const models = await (await fetch(PULSE + "/v1/models")).json();
check("models list has 5 entries", models.data?.length === 5);
check("models owned_by providers", models.data.every((m) => ["limited-free", "flaky-edge", "solid-upstream"].includes(m.owned_by)));

// 3. Simple task -> heuristic fast -> 429 + timeout + success on solid
let r = await chat({ messages: msg("please lint this file and fix typos") });
check("simple: 200", r.status === 200);
check("simple: routed to solid after fallbacks", r.headers.get("x-orbital-provider") === "solid-upstream");
check("simple: tier fast by heuristic", r.headers.get("x-orbital-tier") === "fast" && r.headers.get("x-orbital-routing-reason") === "heuristic");
check("simple: 3 attempts recorded", r.headers.get("x-orbital-fallback-attempts") === "3");
check("simple: model is solid-fast", r.headers.get("x-orbital-model") === "mock-solid-fast");
check("simple: upstream body passthrough", r.json?.choices?.[0]?.message?.content === "served-by-solid:mock-solid-fast");

// 4. Complex task -> frontier
r = await chat({ messages: msg("design the database schema migration and refactor the architecture") });
check("complex: tier frontier", r.headers.get("x-orbital-tier") === "frontier");
check("complex: frontier model", r.headers.get("x-orbital-model") === "mock-solid-frontier");
check("complex: flaky skipped for limited? attempts=2", r.headers.get("x-orbital-fallback-attempts") === "2");

// 5. Explicit header overrides heuristic
r = await chat(
  { messages: msg("design the database schema migration architecture") },
  { "x-orbital-tier": "fast" }
);
check("header override: reason explicit-header", r.headers.get("x-orbital-routing-reason") === "explicit-header");
check("header override: served fast lane", r.headers.get("x-orbital-model") === "mock-solid-fast");

// 6. In-body hint orbital_tier
r = await chat({ messages: msg("please lint this file"), orbital_tier: "frontier" });
check("body hint: reason explicit-body", r.headers.get("x-orbital-routing-reason") === "explicit-body");
check("body hint: frontier served", r.headers.get("x-orbital-model") === "mock-solid-frontier");

// 7. Pinned model via body.model
r = await chat({ messages: msg("hello there friend"), model: "mock-solid-frontier" });
check("pinned model respected", r.status === 200 && r.headers.get("x-orbital-model") === "mock-solid-frontier");

// 8. Invalid body rejected
r = await chat({});
check("invalid body 400", r.status === 400);

// 9. Integration: events reached the bridge over WS
await sleep(800);
const bridgeAfter = (await (await fetch("http://127.0.0.1:4000/health")).json()).eventsRelayed;
const completions = frames.filter((f) => f.type === "agent.completed");
const alerts = frames.filter((f) => f.type === "token.alert.raised");
check("bridge relayed >=10 events", bridgeAfter - bridgeBefore >= 10, `delta=${bridgeAfter - bridgeBefore}`);
check("5 agent.completed received", completions.length === 5, String(completions.length));
check("completed payload has tokens+provider", completions.every((f) => f.payload.provider === "solid-upstream" && typeof f.payload.durationMs === "number" && f.payload.promptTokens === 30 && f.payload.completionTokens === 12));
check("alerts raised per completion", alerts.length === 5, String(alerts.length));
check("alerts carry threshold context", alerts.every((f) => f.payload.thresholdTokens === 10 && f.payload.totalTokens === 42));

// 10. Gateway counters
health = await (await fetch(PULSE + "/health")).json();
check("gateway counted 5 completions", health.requestsCompleted === 5);
check("gateway counted fallbacks", health.fallbacksUsed >= 2);
check("gateway token totals", health.tokensPrompt === 150 && health.tokensCompletion === 60);
check("gateway raised alerts", health.alertsRaised === 5);

ws.close();
console.log(failures === 0 ? "ALL SMOKE TESTS PASSED" : failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
