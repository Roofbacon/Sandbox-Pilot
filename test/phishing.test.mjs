import test from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const { extractUrlTargets, scoreUrlTarget, runEmailUrlPhishingTest } = await import("../dist/phishing.js");

async function freshRoot() {
  const tmp = path.join(os.tmpdir(), "sandbox-phishing-" + randomUUID());
  await fsp.mkdir(tmp, { recursive: true });
  return tmp;
}

test("extracts URL targets from direct input, email text, and HTML anchors", () => {
  const email = `
    <a href="https://evil.example/login?account=1">https://contoso.com/security</a>
    Please also review hxxp://updates.example[.]net/file.zip
  `;

  const targets = extractUrlTargets({ url: "https://safe.example/", emailText: email }, 10);
  assert.equal(targets.length, 4);
  assert.equal(targets[0].source, "input");
  assert.equal(targets[1].source, "htmlAnchor");
  assert.equal(targets[1].anchorText, "https://contoso.com/security");
  assert.equal(targets[3].url, "http://updates.example.net/file.zip");

  const scored = scoreUrlTarget(targets[1]);
  assert.equal(scored.risk, "high");
  assert.ok(scored.findings.some((finding) => finding.message.includes("Link text shows contoso.com")));
});

test("phishing URL test writes report artifacts with sandbox background evidence", async () => {
  const root = await freshRoot();
  const calls = [];
  const deps = {
    bridgeRoot: root,
    async sendCommand(type, args) {
      calls.push({ type, args });
      assert.equal(type, "run_ps");
      return {
        data: {
          stdout: JSON.stringify({
            url: "http://bit.ly/x",
            host: "bit.ly",
            dns: [{ Type: "A", Name: "bit.ly", IPAddress: "1.2.3.4" }],
            tls: null,
            redirects: [
              { url: "http://bit.ly/x", status: 301, location: "https://credential.example/login" },
              { url: "https://credential.example/login", status: 200, contentType: "text/html" },
            ],
            finalUrl: "https://credential.example/login",
            errors: [],
          }),
        },
      };
    },
    async screenshot() {
      throw new Error("foregroundMode=none should not capture screenshots");
    },
  };

  const out = await runEmailUrlPhishingTest(
    deps,
    { url: "http://bit.ly/x", foregroundMode: "none" },
    "2026-06-19T10:00:00.000Z",
  );

  assert.equal(out.verdict, "suspicious");
  assert.equal(out.urlCount, 1);
  assert.equal(calls.length, 1);
  assert.ok(out.artifacts.report.endsWith("report.md"));

  const report = await fsp.readFile(out.artifacts.report, "utf8");
  assert.match(report, /bit\.ly/);
  assert.match(report, /Redirects from bit\.ly to credential\.example/);

  const results = JSON.parse(await fsp.readFile(out.artifacts.results, "utf8"));
  assert.equal(results.urls[0].background.finalUrl, "https://credential.example/login");

  await fsp.rm(root, { recursive: true, force: true });
});

test("foreground SmartScreen blocking evidence escalates the verdict to likely phishing", async () => {
  const root = await freshRoot();
  const sourceShot = path.join(root, "source.jpg");
  await fsp.writeFile(sourceShot, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const calls = [];
  const deps = {
    bridgeRoot: root,
    async sendCommand(type, args) {
      calls.push({ type, args });
      if (calls.length === 1) {
        return {
          data: {
            stdout: JSON.stringify({
              url: "https://example.test/",
              host: "example.test",
              dns: [{ Type: "A", Name: "example.test", IPAddress: "203.0.113.10" }],
              tls: { chainOk: true },
              redirects: [{ url: "https://example.test/", status: 200, contentType: "text/html" }],
              finalUrl: "https://example.test/",
              errors: [],
            }),
          },
        };
      }
      if (calls.length === 2) {
        return { data: { stdout: JSON.stringify({ opened: "https://example.test/", edge: "msedge.exe" }) } };
      }
      return {
        data: {
          rootName: "Reported Unsafe Site: Navigation Blocked - Microsoft Edge",
          nodes: [{ name: "This site has been reported as unsafe and blocked by SmartScreen" }],
        },
      };
    },
    async screenshot() {
      return { base64: "", hostPath: sourceShot, meta: {} };
    },
  };

  const out = await runEmailUrlPhishingTest(
    deps,
    { url: "https://example.test/", foregroundMode: "highestRisk", waitMs: 1000 },
    "2026-06-19T11:00:00.000Z",
  );

  assert.equal(out.verdict, "likely-phishing");
  assert.equal(out.urls[0].risk, "high");
  assert.ok(out.urls[0].topFindings.some((finding) => finding.includes("blocked or unsafe")));

  await fsp.rm(root, { recursive: true, force: true });
});
