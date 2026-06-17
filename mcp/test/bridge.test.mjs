// Offline unit/integration tests for the bridge logic that regressed during development.
// No Windows Sandbox required — both transports are exercised against in-process fakes.
//   run: npm test   (builds first, then `node --test`)
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";

// Both modules resolve their paths from SANDBOX_BRIDGE_ROOT at import time, so set it first.
const tmp = path.join(os.tmpdir(), "sandbox-mcp-test-" + randomUUID());
fs.mkdirSync(path.join(tmp, "commands"), { recursive: true });
fs.mkdirSync(path.join(tmp, "results"), { recursive: true });
process.env.SANDBOX_BRIDGE_ROOT = tmp;

const fileBridge = await import("../dist/bridge.js");
const socketBridge = await import("../dist/socket-bridge.js");

const endpointPath = path.join(tmp, "results", "agent-endpoint.json");

// A fake guest socket agent: reads the auth-token first line, then NDJSON commands, and
// replies via the supplied onCommand(sock, cmd). Tracks sockets so close() drops the
// bridge's reused connection (server.close() alone leaves existing sockets open).
function makeFakeAgent(onCommand) {
  const sockets = [];
  let firstLine = null;
  const server = net.createServer((sock) => {
    sockets.push(sock);
    let buf = "";
    let gotToken = false;
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!gotToken) {
          gotToken = true;
          firstLine = line;
          continue;
        }
        onCommand(sock, JSON.parse(line));
      }
    });
    sock.on("error", () => {});
  });
  return {
    firstLine: () => firstLine,
    async listen(token) {
      await new Promise((res) => server.listen(0, "127.0.0.1", res));
      const { port } = server.address();
      await fsp.writeFile(endpointPath, JSON.stringify({ ip: "127.0.0.1", port, token }));
    },
    close() {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

test("file bridge strips a UTF-8 BOM from the result JSON", async () => {
  // PS 5.1's Set-Content -Encoding UTF8 prepends a BOM that originally broke JSON.parse.
  const watcher = fs.watch(path.join(tmp, "commands"), (_ev, fn) => {
    if (!fn || !fn.toString().endsWith(".json")) return;
    const id = fn.toString().replace(/\.json$/, "");
    const result = { id, type: "screen_info", ok: true, data: { ping: "pong" }, error: null };
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(result))]);
    fs.writeFileSync(path.join(tmp, "results", id + ".json"), buf);
  });
  try {
    const r = await fileBridge.sendCommand("screen_info", {}, 5000);
    assert.equal(r.ok, true);
    assert.equal(r.data.ping, "pong");
  } finally {
    watcher.close();
  }
});

test("socket bridge: sends the auth token first and reassembles chunk-split NDJSON", async () => {
  const token = "tok-" + randomUUID();
  const agent = makeFakeAgent((sock, cmd) => {
    const result = JSON.stringify({ id: cmd.id, type: cmd.type, ok: true, data: { echoed: cmd.type }, error: null });
    const mid = Math.floor(result.length / 2); // split across two TCP writes
    sock.write(result.slice(0, mid));
    setTimeout(() => sock.write(result.slice(mid) + "\n"), 20);
  });
  await agent.listen(token);
  try {
    const r = await socketBridge.sendCommand("ui_tree", {}, 5000);
    assert.equal(r.ok, true);
    assert.equal(r.data.echoed, "ui_tree");
    assert.equal(agent.firstLine(), token, "agent must receive the auth token as the first line");
  } finally {
    agent.close();
  }
});

test("socket bridge: a failed result surfaces as a thrown error", async () => {
  const token = "tok-" + randomUUID();
  const agent = makeFakeAgent((sock, cmd) => {
    sock.write(JSON.stringify({ id: cmd.id, type: cmd.type, ok: false, data: null, error: "boom" }) + "\n");
  });
  await agent.listen(token);
  try {
    await assert.rejects(() => socketBridge.sendCommand("click", { x: 1, y: 1 }, 5000), /boom/);
  } finally {
    agent.close();
  }
});

test.after(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});
