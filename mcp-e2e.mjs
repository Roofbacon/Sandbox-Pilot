// Live end-to-end test of the new features, driven through the actual MCP server (dist/index.js)
// over stdio, against a running Windows Sandbox (prepare-socket + reload-agent first).
//   run: node mcp-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, SANDBOX_TRANSPORT: "socket" },
});
const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(transport);

// Parse a tool result's first text block as JSON.
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const textBlock = (r.content ?? []).find((c) => c.type === "text");
  let data = null;
  try { data = textBlock ? JSON.parse(textBlock.text) : null; } catch { data = textBlock?.text; }
  return { raw: r, data };
}

try {
  // 0. Tool registry includes the new tools.
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const wanted = ["sandbox_health", "sandbox_assert", "sandbox_snapshot", "sandbox_diff_snapshots",
    "sandbox_run_test_plan", "sandbox_event_logs", "sandbox_record_start", "sandbox_record_stop",
    "sandbox_guide_build", "sandbox_cleanup"];
  check("tools registered", wanted.every((w) => tools.includes(w)), `${tools.length} tools`);

  // 1. Handshake / compatibility.
  const health = (await call("sandbox_health")).data;
  check("health: agent responds", health?.ok === true, `screen ${JSON.stringify(health?.screen)}`);
  check("health: version 0.2.0", health?.version === "0.2.0", `version=${health?.version}`);
  check("health: compatible", health?.compatibility?.compatible === true,
    `guestProto=${health?.compatibility?.guestProtocol} serverProto=${health?.compatibility?.serverProtocol} warn=${health?.compatibility?.warning}`);

  // 2. Assertions (presence + expected-absence).
  const asserts = (await call("sandbox_assert", {
    assertions: [
      { type: "file", path: "C:\\Windows\\System32\\kernel32.dll", label: "kernel32 exists" },
      { type: "process", name: "explorer", label: "explorer running" },
      { type: "service", name: "Winmgmt", status: "Running", label: "WMI running" },
      { type: "file", path: "C:\\does\\not\\exist.bin", expectedPresent: false, label: "bogus absent" },
    ],
  })).data;
  check("assert: rollup passed", asserts?.passed === true,
    `${asserts?.passedCount}/${asserts?.total} ${JSON.stringify((asserts?.results ?? []).map((a) => [a.label, a.passed]))}`);

  // 3. Snapshot BEFORE (limit file roots to keep it quick + deterministic for the diff).
  // Clean any residue from a previous run first so the diff is deterministic in a reused VM.
  const beforeRoots = ["C:\\Program Files\\AcmeTest"];
  await call("sandbox_run_ps", {
    command: "Remove-Item 'C:\\Program Files\\AcmeTest' -Recurse -Force -ErrorAction SilentlyContinue; " +
      "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name AcmeTest -ErrorAction SilentlyContinue",
  });
  const before = (await call("sandbox_snapshot", { label: "before", fileRoots: beforeRoots })).data;
  check("snapshot: before captured", !!before?.snapshotId,
    `id=${before?.snapshotId} files=${before?.counts?.files} reg=${before?.counts?.registryValues}`);

  // 4. Make a change + exercise event-log capture via the install-test tool.
  const changeCmd =
    "New-Item -ItemType Directory -Force 'C:\\Program Files\\AcmeTest' | Out-Null; " +
    "Set-Content 'C:\\Program Files\\AcmeTest\\readme.txt' 'hello'; " +
    "New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name AcmeTest -Value 'C:\\Program Files\\AcmeTest\\app.exe' -PropertyType String -Force | Out-Null; " +
    "exit 0";
  const installTest = (await call("sandbox_test_install_command", { command: changeCmd, timeoutMs: 30000 })).data;
  check("install-test: exit 0", installTest?.exitCode === 0, `exit=${installTest?.exitCode} timedOut=${installTest?.timedOut}`);
  check("install-test: event logs collected", installTest?.eventLogs && typeof installTest.eventLogs.count === "number",
    `eventLog count=${installTest?.eventLogs?.count} note=${installTest?.eventLogs?.note}`);

  // 5. Snapshot AFTER + diff.
  const after = (await call("sandbox_snapshot", { label: "after", fileRoots: beforeRoots })).data;
  const diff = (await call("sandbox_diff_snapshots", { beforeId: before.snapshotId, afterId: after.snapshotId })).data;
  const addedFiles = diff?.diff?.files?.added?.items ?? [];
  const addedReg = diff?.diff?.registry?.added?.items ?? [];
  check("diff: detects the new file", addedFiles.some((f) => /readme\.txt$/i.test(f.path)),
    `addedFiles=${JSON.stringify(addedFiles.map((f) => f.path))}`);
  check("diff: detects the new registry value", addedReg.some((v) => v.name === "AcmeTest"),
    `addedReg=${JSON.stringify(addedReg.map((v) => v.name))}`);

  // 6. Standalone event-log query.
  const ev = (await call("sandbox_event_logs", { lastMinutes: 10 })).data;
  check("event_logs: returns a window", Array.isArray(ev?.events), `count=${ev?.count} note=${ev?.note}`);

  // 7. Declarative test plan (run + expectExitCode + assert + capture).
  const plan = (await call("sandbox_run_test_plan", {
    name: "e2e-plan",
    steps: [
      { name: "create marker", run: "Set-Content C:\\Windows\\Temp\\e2e.txt ok; exit 0",
        assert: [{ type: "file", path: "C:\\Windows\\Temp\\e2e.txt", label: "marker exists" }],
        capture: { caption: "marker created" } },
      { name: "reboot-required code accepted", run: "exit 3010", expectExitCode: 3010 },
    ],
  })).data;
  check("test_plan: passed", plan?.passed === true,
    `${plan?.passedCount}/${plan?.total} junit=${plan?.artifacts?.junit ? "written" : "missing"}`);

  // 8. Auto-record a guide, then build MD/HTML/PDF.
  await call("sandbox_guide_reset", { guide: "e2e-guide" });
  await call("sandbox_record_start", { guide: "e2e-guide", annotate: true });
  await call("sandbox_open", { target: "C:\\Windows\\System32\\cmd.exe" });
  await new Promise((r) => setTimeout(r, 1500));
  await call("sandbox_key", { keys: "echo hello from the e2e test{ENTER}" });
  const stop = (await call("sandbox_record_stop")).data;
  check("record: captured steps", (stop?.totalSteps ?? 0) >= 2, `totalSteps=${stop?.totalSteps}`);
  const build = (await call("sandbox_guide_build", { guide: "e2e-guide", title: "E2E Guide", formats: ["markdown", "html", "pdf"] })).data;
  check("guide_build: md+html+pdf", !!(build?.outputs?.markdown && build?.outputs?.html && build?.outputs?.pdf),
    JSON.stringify(build?.outputs));

  // 9. Cleanup (dry run — don't actually delete the artifacts we just made).
  const clean = (await call("sandbox_cleanup", { keepLast: 0, dryRun: true })).data;
  check("cleanup: dry run reports areas", Array.isArray(clean?.areas) && clean?.dryRun === true,
    `totalRemoved(reported)=${clean?.totalRemoved} areas=${(clean?.areas ?? []).map((a) => a.area).join(",")}`);

  // close the console we opened
  await call("sandbox_run_ps", { command: "Stop-Process -Name cmd -Force -ErrorAction SilentlyContinue" }).catch(() => {});
} catch (err) {
  console.error("HARNESS ERROR:", err);
  check("harness completed without throwing", false, err?.message);
} finally {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n==== ${passed}/${results.length} checks passed ====`);
  await client.close();
  process.exit(passed === results.length ? 0 : 1);
}
