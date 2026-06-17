// Offline tests for the guide document builder (Markdown / HTML / PDF). Uses a tiny real JPEG so
// pdf-lib's embedJpg succeeds.
//   run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const { buildGuideDocs } = await import("../dist/guidedoc.js");

// 1x1 JPEG.
const JPEG_1PX =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
  "AAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==";

async function setup() {
  const dir = path.join(os.tmpdir(), "sandbox-guidedoc-" + randomUUID());
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "step-01.jpg"), Buffer.from(JPEG_1PX, "base64"));
  const steps = [{ n: 1, caption: "Click <b>here</b> & confirm", image: "step-01.jpg" }];
  return { dir, steps };
}

test("builds markdown with caption and image reference", async () => {
  const { dir, steps } = await setup();
  const out = await buildGuideDocs({ title: "My Guide", steps, dir, formats: ["markdown"] });
  const md = await fsp.readFile(out.markdown, "utf8");
  assert.match(md, /# My Guide/);
  assert.match(md, /## Step 1/);
  assert.match(md, /Click <b>here<\/b> & confirm/);
  assert.match(md, /!\[Step 1\]\(step-01\.jpg\)/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test("builds self-contained HTML with escaped caption and embedded image", async () => {
  const { dir, steps } = await setup();
  const out = await buildGuideDocs({ title: "My <Guide>", steps, dir, formats: ["html"] });
  const html = await fsp.readFile(out.html, "utf8");
  assert.match(html, /<title>My &lt;Guide&gt;<\/title>/);
  assert.match(html, /Click &lt;b&gt;here&lt;\/b&gt; &amp; confirm/);
  assert.match(html, /data:image\/jpeg;base64,/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test("builds a PDF starting with the %PDF header", async () => {
  const { dir, steps } = await setup();
  const out = await buildGuideDocs({ title: "PDF Guide", steps, dir, formats: ["pdf"] });
  const bytes = await fsp.readFile(out.pdf);
  assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  assert.ok(bytes.length > 500, "PDF has real content");
  await fsp.rm(dir, { recursive: true, force: true });
});

test("can build all formats at once", async () => {
  const { dir, steps } = await setup();
  const out = await buildGuideDocs({ title: "All", steps, dir, formats: ["markdown", "html", "pdf"] });
  assert.ok(out.markdown && out.html && out.pdf);
  for (const p of Object.values(out)) assert.ok(await fsp.stat(p));
  await fsp.rm(dir, { recursive: true, force: true });
});

test("missing image does not fail the build", async () => {
  const dir = path.join(os.tmpdir(), "sandbox-guidedoc-" + randomUUID());
  await fsp.mkdir(dir, { recursive: true });
  const steps = [{ n: 1, caption: "No picture here", image: "nope.jpg" }];
  const out = await buildGuideDocs({ title: "Resilient", steps, dir, formats: ["html", "pdf"] });
  const html = await fsp.readFile(out.html, "utf8");
  assert.match(html, /No picture here/);
  assert.doesNotMatch(html, /data:image/);
  const pdf = await fsp.readFile(out.pdf);
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  await fsp.rm(dir, { recursive: true, force: true });
});
