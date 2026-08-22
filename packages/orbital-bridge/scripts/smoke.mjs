import { WebSocket } from "ws";

const base = "http://127.0.0.1:4000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
  if (!cond) failures++;
};

const messages = [];
const ws = new WebSocket("ws://127.0.0.1:4000/ws");
ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
await sleep(200);

let res = await fetch(base + "/health");
let health = await res.json();
check("health 200", res.status === 200, JSON.stringify(health));
check("health sees 1 client", health.clientsConnected === 1);

const validEvent = {
  id: crypto.randomUUID(),
  type: "task.dispatched",
  source: "synapse",
  occurredAt: new Date().toISOString(),
  schemaVersion: "1.0",
  payload: { taskId: "T-100", title: "smoke" }
};
res = await fetch(base + "/api/events", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(validEvent)
});
let body = await res.json();
check("valid event 202", res.status === 202);
check("delivered to 1 client", body.delivered === 1);
await sleep(200);
check("ws received broadcast", messages.some((m) => m.type === "task.dispatched" && m.id === validEvent.id));

res = await fetch(base + "/api/events", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ nope: true })
});
check("invalid event 422", res.status === 422);

res = await fetch(base + "/api/fs");
let listing = await res.json();
check("fs root listing", res.status === 200 && Array.isArray(listing.entries));

res = await fetch(base + "/api/fs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "tmp-smoke/hello.txt", contents: "hola orbital" })
});
check("fs create 201", res.status === 201);
await sleep(600);
check(
  "ws artifact.created on mutation",
  messages.some((m) => m.type === "artifact.created" && m.payload?.path === "tmp-smoke/hello.txt")
);

res = await fetch(base + "/api/fs?path=" + encodeURIComponent("tmp-smoke/hello.txt"));
let file = await res.json();
check("fs read back contents", file.contents === "hola orbital");

res = await fetch(base + "/api/fs", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "tmp-smoke/hello.txt", contents: "v2" })
});
check("fs overwrite 200", res.status === 200);

res = await fetch(base + "/api/fs", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "tmp-smoke/hello.txt", contents: "dup" })
});
check("fs duplicate create 409", res.status === 409);

for (const [label, evilPath] of [
  ["traversal ../ blocked", "../escaped.txt"],
  [".git blocked", ".git/config"],
  ["node_modules blocked", "node_modules/ws/package.json"],
  ["absolute path blocked", "C:/Windows/win.ini"]
]) {
  res = await fetch(base + "/api/fs?path=" + encodeURIComponent(evilPath));
  check(label, res.status === 400);
}

res = await fetch(base + "/api/fs?path=" + encodeURIComponent("tmp-smoke"), { method: "DELETE" });
check("dir delete requires recursive", res.status === 400);
res = await fetch(base + "/api/fs?path=" + encodeURIComponent("tmp-smoke") + "&recursive=true", {
  method: "DELETE"
});
check("dir delete 200", res.status === 200);
res = await fetch(base + "/api/fs?path=" + encodeURIComponent("tmp-smoke/hello.txt"));
check("deleted file is 404", res.status === 404);

ws.close();
console.log(failures === 0 ? "ALL SMOKE TESTS PASSED" : failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
