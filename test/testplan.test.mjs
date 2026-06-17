// Offline tests for the host-side test-plan runner. No Windows Sandbox required — the guest
// transport (sendCommand) and screenshot are in-process fakes, so we exercise step orchestration,
// exit-code gating, assertion roll-up, fail-fast/skip behavior, and the JUnit/summary artifacts.
//   run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const { runTestPlan } = await import("../dist/testplan.js");

function makeDeps(bridgeRoot, handlers = {}) {
  const calls = [];
  const deps = {
    bridgeRoot,
    toBridgeHostPath: (rel) => (rel ? path.join(bridgeRoot, rel) : null),
    async sendCommand(type, args) {
      calls.push({ type, args });
      const handler = handlers[type];
      const data = typeof handler === "function" ? handler(args) : handler ?? {};
      return { ok: true, data };
    },
    async screenshot() {
      // 1x1 JPEG-ish bytes; content does not matter for the test.
      return { base64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"), hostPath: "ignored" };
    },
  };
  return { deps, calls };
}

async function freshRoot() {
  const tmp = path.join(os.tmpdir(), "sandbox-testplan-" + randomUUID());
  await fsp.mkdir(tmp, { recursive: true });
  return tmp;
}

test("a passing plan writes junit/results/summary and reports all steps passed", async () => {
  const root = await freshRoot();
  const { deps, calls } = makeDeps(root, {
    installer_test: () => ({ exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }),
    assert: () => ({ passed: true, total: 1, passedCount: 1, failedCount: 0, results: [{ label: "app installed", type: "installedProgram", detected: true, expectedPresent: true, passed: true }] }),
  });

  const out = await runTestPlan(
    deps,
    {
      name: "Install Acme",
      steps: [
        { name: "Silent install", run: "msiexec /i acme.msi /qn", assert: [{ type: "installedProgram", name: "Acme", label: "app installed" }], capture: { caption: "After install" } },
      ],
    },
    "2026-06-17T10:00:00.000Z",
  );

  assert.equal(out.passed, true);
  assert.equal(out.total, 1);
  assert.equal(out.passedCount, 1);
  assert.equal(out.steps[0].status, "passed");

  // installer_test was invoked with the command, and a screenshot was captured.
  assert.ok(calls.some((c) => c.type === "installer_test" && c.args.command.includes("acme.msi")));

  const junit = await fsp.readFile(out.artifacts.junit, "utf8");
  assert.match(junit, /<testsuite name="Install Acme" tests="1" failures="0"/);
  assert.match(junit, /<testcase name="Silent install"/);

  const summary = await fsp.readFile(out.artifacts.summary, "utf8");
  assert.match(summary, /\*\*PASSED\*\*/);
  assert.match(summary, /!\[Silent install\]\(step-01\.jpg\)/);
  assert.ok(fs.existsSync(path.join(out.artifacts.dir, "step-01.jpg")), "capture image is written");

  await fsp.rm(root, { recursive: true, force: true });
});

test("a nonzero exit code fails the step and skips the rest (fail-fast)", async () => {
  const root = await freshRoot();
  const { deps } = makeDeps(root, {
    installer_test: () => ({ exitCode: 1603, timedOut: false, stdout: "", stderr: "fatal" }),
  });

  const out = await runTestPlan(
    deps,
    {
      name: "Upgrade",
      steps: [
        { name: "Install v1", run: "setup.exe /S" },
        { name: "Install v2 over v1", run: "setup2.exe /S" },
      ],
    },
    "2026-06-17T11:00:00.000Z",
  );

  assert.equal(out.passed, false);
  assert.equal(out.failedCount, 1);
  assert.equal(out.skippedCount, 1);
  assert.equal(out.steps[0].status, "failed");
  assert.equal(out.steps[1].status, "skipped");

  const junit = await fsp.readFile(out.artifacts.junit, "utf8");
  assert.match(junit, /failures="1" skipped="1"/);
  assert.match(junit, /<failure message="[^"]*exit 1603/);
  assert.match(junit, /<skipped\/>/);

  await fsp.rm(root, { recursive: true, force: true });
});

test("expectExitCode lets a known nonzero code count as success", async () => {
  const root = await freshRoot();
  const { deps } = makeDeps(root, {
    installer_test: () => ({ exitCode: 3010, timedOut: false }), // soft reboot required
  });

  const out = await runTestPlan(
    deps,
    { name: "Reboot-required install", steps: [{ name: "Install", run: "setup.exe", expectExitCode: 3010 }] },
    "2026-06-17T12:00:00.000Z",
  );

  assert.equal(out.passed, true);
  assert.equal(out.steps[0].status, "passed");
  await fsp.rm(root, { recursive: true, force: true });
});

test("a failed assertion fails the step even when the command succeeds", async () => {
  const root = await freshRoot();
  const { deps } = makeDeps(root, {
    installer_test: () => ({ exitCode: 0, timedOut: false }),
    assert: () => ({ passed: false, total: 1, passedCount: 0, failedCount: 1, results: [{ label: "service running", type: "service", detected: false, expectedPresent: true, passed: false }] }),
  });

  const out = await runTestPlan(
    deps,
    { name: "Verify service", steps: [{ name: "Install + check service", run: "setup.exe /S", assert: [{ type: "service", name: "AcmeSvc", status: "Running", label: "service running" }] }] },
    "2026-06-17T13:00:00.000Z",
  );

  assert.equal(out.passed, false);
  assert.equal(out.steps[0].status, "failed");
  assert.match(out.steps[0].failureReasons.join(" "), /service running/);
  await fsp.rm(root, { recursive: true, force: true });
});

test("continueOnFailure keeps running later steps", async () => {
  const root = await freshRoot();
  const { deps } = makeDeps(root, {
    installer_test: () => ({ exitCode: 1, timedOut: false }),
  });

  const out = await runTestPlan(
    deps,
    {
      name: "Best effort",
      steps: [
        { name: "Flaky step", run: "maybe.exe", continueOnFailure: true },
        { name: "Still runs", run: "next.exe", expectExitCode: 1 },
      ],
    },
    "2026-06-17T14:00:00.000Z",
  );

  assert.equal(out.steps[0].status, "failed");
  assert.equal(out.steps[1].status, "passed");
  assert.equal(out.skippedCount, 0);
  await fsp.rm(root, { recursive: true, force: true });
});

test("XML special characters in names are escaped in junit", async () => {
  const root = await freshRoot();
  const { deps } = makeDeps(root, { installer_test: () => ({ exitCode: 0, timedOut: false }) });

  const out = await runTestPlan(
    deps,
    { name: "Tom & Jerry <test>", steps: [{ name: 'quote " and <tag>', run: "ok.exe" }] },
    "2026-06-17T15:00:00.000Z",
  );

  const junit = await fsp.readFile(out.artifacts.junit, "utf8");
  assert.match(junit, /name="Tom &amp; Jerry &lt;test&gt;"/);
  assert.match(junit, /name="quote &quot; and &lt;tag&gt;"/);
  await fsp.rm(root, { recursive: true, force: true });
});
