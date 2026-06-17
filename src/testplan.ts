import * as fsp from "node:fs/promises";
import * as path from "node:path";

// Host-side test-plan runner. It orchestrates existing guest commands (open / installer_test /
// assert) step by step, optionally captures a screenshot per step for documentation, and writes
// machine-readable (JUnit XML + results.json) and human-readable (summary.md) reports into the
// shared bridge so the user can pick them up directly.

export interface AssertionSpec {
  type: string;
  label?: string;
  expectedPresent?: boolean;
  [key: string]: unknown;
}

export interface StepSpec {
  name: string;
  open?: string;
  run?: string;
  runTimeoutMs?: number;
  expectExitCode?: number;
  collectEventLogs?: boolean;
  assert?: AssertionSpec[];
  assertTimeoutMs?: number;
  capture?: { caption?: string; window?: boolean; region?: number[] };
  continueOnFailure?: boolean;
}

export interface TestPlan {
  name: string;
  steps: StepSpec[];
}

type StepStatus = "passed" | "failed" | "skipped";

export interface RunnerDeps {
  sendCommand: (type: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<{ data: any }>;
  screenshot: (opts: { window?: boolean; region?: number[] }) => Promise<{ base64: string; hostPath: string; meta?: any }>;
  bridgeRoot: string;
  toBridgeHostPath: (relativePath?: string | null) => string | null;
}

interface StepResult {
  name: string;
  status: StepStatus;
  durationMs: number;
  open?: { target: string; result: any };
  run?: { command: string; exitCode: number | null; timedOut: boolean; expectExitCode: number; passed: boolean; stdoutTail?: string[]; stderrTail?: string[]; eventLogs?: any };
  asserts?: any;
  capture?: { caption?: string; file: string; hostPath: string };
  error?: string;
  failureReasons: string[];
}

function xmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "") || "plan";
}

function tail(text: unknown, lines = 20): string[] {
  if (text == null) return [];
  return String(text).split(/\r?\n/).slice(-lines);
}

function buildJUnit(plan: TestPlan, steps: StepResult[], totalMs: number): string {
  const failures = steps.filter((s) => s.status === "failed").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;
  const cases = steps
    .map((s) => {
      const time = (s.durationMs / 1000).toFixed(3);
      let inner = "";
      if (s.status === "failed") {
        const msg = s.failureReasons.join("; ") || s.error || "Step failed.";
        inner = `\n      <failure message="${xmlEscape(msg)}">${xmlEscape(JSON.stringify(s, null, 2))}</failure>\n    `;
      } else if (s.status === "skipped") {
        inner = `\n      <skipped/>\n    `;
      }
      return `    <testcase name="${xmlEscape(s.name)}" classname="${xmlEscape(plan.name)}" time="${time}">${inner}</testcase>`;
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites>\n` +
    `  <testsuite name="${xmlEscape(plan.name)}" tests="${steps.length}" failures="${failures}" skipped="${skipped}" time="${(totalMs / 1000).toFixed(3)}">\n` +
    `${cases}\n` +
    `  </testsuite>\n` +
    `</testsuites>\n`
  );
}

function statusIcon(status: StepStatus): string {
  return status === "passed" ? "✅" : status === "failed" ? "❌" : "⏭️";
}

function buildMarkdown(plan: TestPlan, steps: StepResult[], summary: any): string {
  let md = `# Test plan: ${plan.name}\n\n`;
  md += `**${summary.passed ? "PASSED" : "FAILED"}** — ${summary.passedCount}/${summary.total} steps passed`;
  if (summary.skippedCount) md += `, ${summary.skippedCount} skipped`;
  md += ` (${(summary.durationMs / 1000).toFixed(1)}s)\n\n`;

  md += `| # | Step | Result |\n|---|---|---|\n`;
  steps.forEach((s, i) => {
    md += `| ${i + 1} | ${s.name} | ${statusIcon(s.status)} ${s.status} |\n`;
  });
  md += `\n`;

  steps.forEach((s, i) => {
    md += `## ${i + 1}. ${s.name} ${statusIcon(s.status)}\n\n`;
    if (s.run) {
      md += `- Command: \`${s.run.command}\` → exit ${s.run.exitCode ?? "n/a"}${s.run.timedOut ? " (timed out)" : ""} (expected ${s.run.expectExitCode})\n`;
    }
    if (s.open) md += `- Opened: \`${s.open.target}\`\n`;
    if (s.asserts) {
      for (const a of s.asserts.results ?? []) {
        md += `- ${a.passed ? "✅" : "❌"} assert \`${a.label}\` (${a.type}) — detected=${a.detected}, expectedPresent=${a.expectedPresent}\n`;
      }
    }
    if (s.failureReasons.length) md += `- **Failure:** ${s.failureReasons.join("; ")}\n`;
    if (s.error) md += `- **Error:** ${s.error}\n`;
    const events = s.run?.eventLogs?.events ?? [];
    if (events.length && s.status === "failed") {
      md += `- **Event log (${events.length}):**\n`;
      for (const e of events.slice(0, 15)) {
        md += `  - \`${e.timeCreated}\` ${e.logName}/${e.levelDisplayName} ${e.providerName} [${e.id}]: ${e.message}\n`;
      }
    }
    if (s.capture) {
      if (s.capture.caption) md += `\n${s.capture.caption}\n`;
      md += `\n![${s.name}](${s.capture.file})\n`;
    }
    md += `\n`;
  });
  return md;
}

export async function runTestPlan(deps: RunnerDeps, plan: TestPlan, stampIso: string): Promise<any> {
  const runId = `${sanitize(plan.name)}-${stampIso.replace(/[:.]/g, "-")}`;
  const runDir = path.join(deps.bridgeRoot, "artifacts", "testplans", runId);
  await fsp.mkdir(runDir, { recursive: true });

  const steps: StepResult[] = [];
  const planStart = Date.now();
  let stop = false;

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const nn = String(i + 1).padStart(2, "0");

    if (stop) {
      steps.push({ name: step.name, status: "skipped", durationMs: 0, failureReasons: ["Skipped after an earlier step failed."] });
      continue;
    }

    const stepStart = Date.now();
    const result: StepResult = { name: step.name, status: "passed", durationMs: 0, failureReasons: [] };

    try {
      if (step.open) {
        const r = await deps.sendCommand("open", { target: step.open }, 30000);
        result.open = { target: step.open, result: r.data };
        if (r.data?.warning) result.failureReasons.push(`open warning: ${r.data.warning}`);
      }

      if (step.run) {
        const timeoutMs = step.runTimeoutMs ?? 120000;
        const collectEventLogs = step.collectEventLogs ?? false;
        const r = await deps.sendCommand("installer_test", { command: step.run, timeoutMs, collectEventLogs }, Math.max(timeoutMs, 1000) + 30000);
        const expect = step.expectExitCode ?? 0;
        const exitCode = r.data?.exitCode ?? null;
        const timedOut = !!r.data?.timedOut;
        const runPassed = !timedOut && exitCode === expect;
        result.run = {
          command: step.run,
          exitCode,
          timedOut,
          expectExitCode: expect,
          passed: runPassed,
          stdoutTail: tail(r.data?.stdout),
          stderrTail: tail(r.data?.stderr),
          eventLogs: r.data?.eventLogs ?? null,
        };
        if (!runPassed) {
          result.failureReasons.push(timedOut ? "run command timed out" : `run exit ${exitCode} != expected ${expect}`);
        }
      }

      if (step.assert && step.assert.length) {
        const timeoutMs = step.assertTimeoutMs ?? 30000;
        const r = await deps.sendCommand("assert", { assertions: step.assert, timeoutMs }, Math.max(timeoutMs, 1000) + 5000);
        result.asserts = r.data;
        if (!r.data?.passed) {
          const failed = (r.data?.results ?? []).filter((a: any) => !a.passed).map((a: any) => a.label);
          result.failureReasons.push(`failed assertions: ${failed.join(", ")}`);
        }
      }

      if (step.capture) {
        const shot = await deps.screenshot({ window: step.capture.window, region: step.capture.region });
        const file = `step-${nn}.jpg`;
        await fsp.writeFile(path.join(runDir, file), Buffer.from(shot.base64, "base64"));
        result.capture = { caption: step.capture.caption, file, hostPath: path.join(runDir, file) };
      }
    } catch (err: any) {
      result.error = err?.message ?? String(err);
      result.failureReasons.push(`step threw: ${result.error}`);
    }

    result.status = result.failureReasons.length === 0 ? "passed" : "failed";
    result.durationMs = Date.now() - stepStart;
    steps.push(result);

    if (result.status === "failed" && !step.continueOnFailure) stop = true;
  }

  const totalMs = Date.now() - planStart;
  const failedCount = steps.filter((s) => s.status === "failed").length;
  const skippedCount = steps.filter((s) => s.status === "skipped").length;
  const passedCount = steps.filter((s) => s.status === "passed").length;
  const summary = {
    runId,
    name: plan.name,
    passed: failedCount === 0,
    total: steps.length,
    passedCount,
    failedCount,
    skippedCount,
    durationMs: totalMs,
  };

  const resultsPath = path.join(runDir, "results.json");
  const junitPath = path.join(runDir, "junit.xml");
  const summaryPath = path.join(runDir, "summary.md");
  await fsp.writeFile(resultsPath, JSON.stringify({ ...summary, steps }, null, 2), "utf8");
  await fsp.writeFile(junitPath, buildJUnit(plan, steps, totalMs), "utf8");
  await fsp.writeFile(summaryPath, buildMarkdown(plan, steps, summary), "utf8");

  return {
    ...summary,
    artifacts: { dir: runDir, results: resultsPath, junit: junitPath, summary: summaryPath },
    steps: steps.map((s) => ({ name: s.name, status: s.status, durationMs: s.durationMs, failureReasons: s.failureReasons })),
  };
}
