// Live software/Intune test through the MCP server against a running Windows Sandbox.
// Prereq: a real MSI staged in C:\PkgSrc inside the Sandbox (see README dev notes).
//   run: node mcp-intune-e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TIMEOUT = 300000;
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const transport = new StdioClientTransport({
  command: "node", args: ["dist/index.js"],
  env: { ...process.env, SANDBOX_TRANSPORT: "socket" },
});
const client = new Client({ name: "intune-e2e", version: "1.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: TIMEOUT });
  const t = (r.content ?? []).find((c) => c.type === "text");
  let d = null; try { d = t ? JSON.parse(t.text) : null; } catch { d = t?.text; }
  return { isError: r.isError, d };
};

try {
  const SRC = "C:\\PkgSrc";

  // 1. Find installer candidates in the staged folder.
  const cand = (await call("sandbox_find_install_candidates", { path: SRC })).d;
  const list = Array.isArray(cand) ? cand : (cand?.candidates ?? []);
  const msiEntry = list.find((c) => /\.msi$/i.test(c.path || c.fullName || ""));
  const msiPath = msiEntry?.path || msiEntry?.fullName;
  check("find_install_candidates: MSI found", !!msiPath, `${list.length} candidate(s); msi=${msiPath}`);
  const setupFile = msiPath ? msiPath.split("\\").pop() : null;

  // 2. Inspect the MSI.
  const insp = (await call("sandbox_msi_inspect", { path: msiPath })).d;
  const productCode = insp?.productCode;
  check("msi_inspect: product metadata", /^\{[0-9A-Fa-f-]+\}$/.test(productCode || ""),
    `name="${insp?.productName}" ver=${insp?.productVersion} code=${productCode}`);

  // 3. Baseline snapshot. Kill any stuck msiexec (closes a lingering installer dialog), then
  // uninstall cleanly. Quote the product code so PowerShell does not parse {GUID} as a scriptblock.
  const roots = ["C:\\Program Files\\7-Zip"];
  await call("sandbox_run_ps", {
    command: `Stop-Process -Name msiexec -Force -ErrorAction SilentlyContinue; Start-Sleep 1; ` +
      `Start-Process msiexec -ArgumentList '/x','"${productCode}"','/qn','/norestart' -Wait; Start-Sleep 2`,
  });
  const before = (await call("sandbox_snapshot", { label: "pre-install", fileRoots: roots })).d;
  check("snapshot: baseline", !!before?.snapshotId, `files=${before?.counts?.files}`);

  // 4. Silent install + event-log capture.
  const inst = (await call("sandbox_test_install_command", {
    command: `msiexec /i "${msiPath}" /qn /norestart`, timeoutMs: 120000,
  })).d;
  check("install: silent exit 0", inst?.exitCode === 0, `exit=${inst?.exitCode} newPrograms=${(inst?.newPrograms ?? []).length} eventLogs=${inst?.eventLogs?.count}`);

  // 5. Footprint via snapshot diff.
  const after = (await call("sandbox_snapshot", { label: "post-install", fileRoots: roots })).d;
  const diff = (await call("sandbox_diff_snapshots", { beforeId: before.snapshotId, afterId: after.snapshotId })).d;
  const fileAdds = diff?.counts?.files?.added ?? 0;
  const regAdds = diff?.counts?.registry?.added ?? 0;
  const progAdds = diff?.counts?.programs?.added ?? 0;
  check("diff: footprint captured", fileAdds > 0 && progAdds > 0,
    `+${fileAdds} files, +${regAdds} reg, +${progAdds} programs`);

  // 6. Detection present.
  const detOn = (await call("sandbox_verify_detection_rule", {
    rule: { type: "msiProductCode", productCode }, expectedPresent: true,
  })).d;
  check("detection: present after install", detOn?.passed === true && detOn?.detected === true,
    `matchCount=${detOn?.evidence?.matchCount}`);

  // 7. Silent uninstall. Quote the product code (PowerShell would treat {GUID} as a scriptblock).
  const unins = (await call("sandbox_test_install_command", {
    command: `msiexec /x "${productCode}" /qn /norestart`, timeoutMs: 120000,
  })).d;
  check("uninstall: silent exit 0", unins?.exitCode === 0, `exit=${unins?.exitCode}`);

  // 8. Detection absent.
  const detOff = (await call("sandbox_verify_detection_rule", {
    rule: { type: "msiProductCode", productCode }, expectedPresent: false,
  })).d;
  check("detection: absent after uninstall", detOff?.passed === true && detOff?.detected === false, "");

  // 9. Intune tool prereq.
  const prereq = (await call("sandbox_intune_prereqs", { ensureTool: true })).d;
  check("intune_prereqs: tool available", prereq?.available === true, `path=${prereq?.path} version=${prereq?.version}`);

  // 10. Full packaging gate (install -> detect -> uninstall -> detect-absent -> package).
  const pkg = (await call("sandbox_intune_package_win32", {
    sourceFolder: SRC, setupFile, testInstall: true, verifyDetection: true, testUninstall: true,
  })).d;
  const pkgFile = (pkg?.packages ?? [])[0];
  check("intune_package_win32: produced .intunewin", pkg?.succeeded === true && !!pkgFile,
    `succeeded=${pkg?.succeeded} file=${pkgFile?.file} hostPath=${pkgFile?.hostPath}`);
  check("intune_package_win32: validation gate passed",
    pkg?.installTest?.exitCode === 0 && pkg?.detectionAfterInstall?.passed === true &&
    pkg?.uninstallTest && pkg?.detectionAfterUninstall?.passed === true,
    `install=${pkg?.installTest?.exitCode} detOn=${pkg?.detectionAfterInstall?.passed} unins=${pkg?.uninstallTest?.exitCode ?? pkg?.uninstallTest?.skipped} detOff=${pkg?.detectionAfterUninstall?.passed}`);
} catch (err) {
  console.error("HARNESS ERROR:", err);
  check("harness completed", false);
} finally {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n==== ${passed}/${results.length} checks passed ====`);
  await client.close();
  process.exit(passed === results.length ? 0 : 1);
}
