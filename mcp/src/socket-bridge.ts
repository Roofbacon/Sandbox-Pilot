import * as net from "node:net";
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { bridgeRoot, type BridgeResult, type Screenshot, type ScreenshotOpts } from "./bridge.js";

/**
 * Low-latency transport: the guest agent listens (and opens its own firewall); the host
 * connects OUT to it (outbound needs no host firewall rule). Commands/results are NDJSON;
 * screenshots arrive as base64 in the result, so the shared folder is off the hot path.
 * The guest publishes its endpoint to results/agent-endpoint.json (guest->host is fast).
 */

const screenshotsDir = path.join(bridgeRoot, "artifacts", "screenshots");
const endpointPath = path.join(bridgeRoot, "results", "agent-endpoint.json");

interface Pending {
  resolve: (r: BridgeResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
let socket: net.Socket | null = null;
let connecting: Promise<net.Socket> | null = null;
let buffer = "";

async function readEndpoint(timeoutMs = 30000): Promise<{ ip: string; port: number; token?: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      let raw = await fsp.readFile(endpointPath, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const ep = JSON.parse(raw);
      if (ep && ep.ip && ep.port) return { ip: ep.ip, port: ep.port, token: ep.token };
    } catch {
      /* not published yet */
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "No agent endpoint at results/agent-endpoint.json. Start the agent in socket mode (attach-socket).",
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function failAllPending(err: Error) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

function connect(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return Promise.resolve(socket);
  if (connecting) return connecting;
  connecting = (async () => {
    const ep = await readEndpoint();
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: ep.ip, port: ep.port });
      s.setNoDelay(true);
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    sock.setEncoding("utf8");
    // Auth handshake: the token published in agent-endpoint.json must be the first line.
    if (ep.token) sock.write(ep.token + "\n");
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: BridgeResult;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        }
      }
    });
    sock.on("close", () => {
      socket = null;
      buffer = "";
      failAllPending(new Error("socket closed by guest"));
    });
    sock.on("error", () => {
      /* close handler does the cleanup */
    });
    socket = sock;
    connecting = null;
    return sock;
  })();
  // If connecting fails, clear the latch so the next call retries.
  connecting.catch(() => {
    connecting = null;
  });
  return connecting;
}

export async function sendCommand(
  type: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30000,
): Promise<BridgeResult> {
  const s = await connect();
  const id = randomUUID();
  const line = JSON.stringify({ id, type, args }) + "\n";
  const result = await new Promise<BridgeResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for sandbox result ${id} after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    s.write(line);
  });
  if (!result.ok) throw new Error(result.error ?? `Command '${type}' failed`);
  return result;
}

export async function screenshot(opts: ScreenshotOpts = {}): Promise<Screenshot> {
  const result = await sendCommand(
    "screenshot",
    { maxWidth: opts.maxWidth ?? 1280, quality: opts.quality ?? 70, region: opts.region, window: opts.window ?? false },
    opts.timeoutMs ?? 60000,
  );
  const hostPath = path.join(screenshotsDir, path.win32.basename(result.data.path));
  return {
    base64: result.data.imageBase64,
    mimeType: "image/jpeg",
    hostPath,
    metadataPath: hostPath.replace(/\.jpg$/i, ".json"),
    meta: result.data,
  };
}
