// Contract tests between the MCP server and the guest agent. These read the source text (no
// Sandbox, and no dot-sourcing — the guest's input-synthesis P/Invoke trips host AV), so they
// catch the drift the version/capability handshake is meant to surface.
//   run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const guestSrc = await fsp.readFile(path.join(here, "..", "guest", "SandboxAgent.ps1"), "utf8");
const serverSrc = await fsp.readFile(path.join(here, "..", "src", "index.ts"), "utf8");
const wingetBootstrapSrc = await fsp.readFile(path.join(here, "..", "bridge", "BootstrapWinget.ps1"), "utf8");

function advertisedCommands() {
  const block = guestSrc.match(/\$AgentCommands\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(block, "found $AgentCommands array in the guest agent");
  return [...block[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

test("every advertised command has a dispatcher case in the guest agent", () => {
  const commands = advertisedCommands();
  assert.ok(commands.length > 20, "expected a substantial command list");
  for (const cmd of commands) {
    assert.ok(
      new RegExp(`"${cmd}"\\s*\\{`).test(guestSrc),
      `advertised command "${cmd}" has no matching dispatcher case (capability list drifted)`,
    );
  }
});

test("guest protocol matches the server's EXPECTED_GUEST_PROTOCOL", () => {
  const guest = guestSrc.match(/\$AgentProtocol\s*=\s*(\d+)/);
  const serverExpected = serverSrc.match(/EXPECTED_GUEST_PROTOCOL\s*=\s*(\d+)/);
  assert.ok(guest && serverExpected, "both protocol constants are present");
  assert.equal(
    guest[1],
    serverExpected[1],
    "guest $AgentProtocol and server EXPECTED_GUEST_PROTOCOL disagree — bump them together on a contract change",
  );
});

test("the health command advertises version, protocol, and the command list", () => {
  // Ensure the handshake fields are actually returned by the health command, not just defined.
  assert.match(guestSrc, /version\s*=\s*\$AgentVersion/);
  assert.match(guestSrc, /protocol\s*=\s*\$AgentProtocol/);
  assert.match(guestSrc, /commands\s*=\s*@\(\$AgentCommands\)/);
});

test("WinGet tools are registered and use the supported Sandbox bootstrap path", () => {
  assert.match(serverSrc, /"sandbox_winget_bootstrap"/);
  assert.match(serverSrc, /"sandbox_winget"/);
  assert.ok(advertisedCommands().includes("winget_bootstrap"));
  assert.ok(advertisedCommands().includes("winget"));
  assert.match(wingetBootstrapSrc, /Install-Module\s+-Name\s+Microsoft\.WinGet\.Client/);
  assert.match(wingetBootstrapSrc, /Repair-WinGetPackageManager[^\r\n]*-AllUsers/);
});

test("sandbox_winget pins the winget source by default and interprets exit codes", () => {
  // The msstore source needs a signed-in account and pops GUIs, so unattended Sandbox runs
  // default to the community 'winget' source and surface a decoded outcome to the caller.
  assert.match(serverSrc, /preferWingetSource/);
  assert.match(guestSrc, /function Get-WinGetExitInfo/);
  assert.match(guestSrc, /PreferWingetSource/);
  assert.match(guestSrc, /NO_APPLICABLE_INSTALLER/);
  // The captured-process helper must drain stdout/stderr asynchronously to avoid the pipe-buffer
  // deadlock that surfaces as bogus winget timeouts.
  assert.match(guestSrc, /ReadToEndAsync\(\)/);
});
