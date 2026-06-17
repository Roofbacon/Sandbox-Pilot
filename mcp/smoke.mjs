// End-to-end smoke test: launches the built MCP server over stdio with the official
// SDK client, lists tools, and exercises ui_tree + screenshot against the live Sandbox.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "dist", "index.js");

const TRANSPORT = process.env.SANDBOX_TRANSPORT === "socket" ? "socket" : "file";
const transport = new StdioClientTransport({
  command: "node",
  args: [serverEntry],
  env: { ...process.env },
});
const client = new Client({ name: "smoke", version: "0.0.0" });

console.log(`transport=${TRANSPORT}`);
const t0 = Date.now();
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

console.log("\n-- sandbox_ui_tree (onlyInteractive) --");
const tUi = Date.now();
const ui = await client.callTool({ name: "sandbox_ui_tree", arguments: { onlyInteractive: true, maxNodes: 8 } });
const uiData = JSON.parse(ui.content.find((c) => c.type === "text").text);
console.log(`root="${uiData.rootName}" nodes=${uiData.nodeCount} (${Date.now() - tUi}ms)`);
console.log("first nodes:", uiData.nodes.slice(0, 3).map((n) => `${n.type}:${n.name}@[${n.click}]`));

console.log("\n-- sandbox_screenshot --");
const tShot = Date.now();
const shot = await client.callTool({ name: "sandbox_screenshot", arguments: {} });
const img = shot.content.find((c) => c.type === "image");
const meta = JSON.parse(shot.content.find((c) => c.type === "text").text);
console.log(`image mime=${img.mimeType} base64Len=${img.data.length} dims=${meta.width}x${meta.height} scale=${meta.scale} (${Date.now() - tShot}ms)`);

await client.close();
console.log(`\nOK total ${Date.now() - t0}ms`);
