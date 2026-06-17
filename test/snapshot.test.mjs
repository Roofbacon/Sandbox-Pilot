// Offline tests for the host-side snapshot diff. Snapshots are plain JSON files in the bridge, so
// we write two by hand and assert the diff classifies files/registry/programs/services correctly
// and writes diff.json + diff.md.
//   run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const { diffSnapshots } = await import("../dist/snapshot.js");

async function freshRoot() {
  const tmp = path.join(os.tmpdir(), "sandbox-snapshot-" + randomUUID());
  await fsp.mkdir(tmp, { recursive: true });
  return tmp;
}

async function writeSnapshot(bridgeRoot, id, sections, label = "") {
  const dir = path.join(bridgeRoot, "artifacts", "snapshots", id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, "snapshot.json"),
    JSON.stringify({ snapshotId: id, label, createdAt: "2026-06-17T00:00:00.000Z", sections }, null, 2),
    "utf8",
  );
}

test("classifies added / removed / modified files, registry, programs, services", async () => {
  const root = await freshRoot();

  await writeSnapshot(root, "before", {
    files: { files: [
      { path: "C:\\Program Files\\Acme\\keep.dll", size: 10, mtime: "t1" },
      { path: "C:\\Program Files\\Acme\\gone.dll", size: 20, mtime: "t1" },
      { path: "C:\\Program Files\\Acme\\changed.dll", size: 30, mtime: "t1" },
    ] },
    registry: { values: [
      { key: "HKLM:\\...\\Uninstall\\Acme", name: "DisplayVersion", value: "1.0.0" },
      { key: "HKLM:\\...\\Run", name: "Old", value: "x" },
    ] },
    programs: { programs: [{ id: "Acme", displayName: "Acme", displayVersion: "1.0.0" }] },
    services: { services: [{ name: "AcmeSvc", displayName: "Acme", status: "Stopped", startType: "Manual" }] },
  });

  await writeSnapshot(root, "after", {
    files: { files: [
      { path: "C:\\Program Files\\Acme\\keep.dll", size: 10, mtime: "t1" },
      { path: "C:\\Program Files\\Acme\\new.dll", size: 40, mtime: "t2" },
      { path: "C:\\Program Files\\Acme\\changed.dll", size: 35, mtime: "t2" }, // size + mtime changed
    ] },
    registry: { values: [
      { key: "HKLM:\\...\\Uninstall\\Acme", name: "DisplayVersion", value: "1.1.0" }, // changed
      { key: "HKLM:\\...\\Run", name: "New", value: "y" }, // added (Old removed)
    ] },
    programs: { programs: [{ id: "Acme", displayName: "Acme", displayVersion: "1.1.0" }] }, // changed version
    services: { services: [{ name: "AcmeSvc", displayName: "Acme", status: "Running", startType: "Automatic" }] }, // changed
  });

  const out = await diffSnapshots({ bridgeRoot: root }, "before", "after", "2026-06-17T10:00:00.000Z");

  assert.deepEqual(out.counts.files, { added: 1, removed: 1, changed: 1 });
  assert.deepEqual(out.counts.registry, { added: 1, removed: 1, changed: 1 });
  assert.deepEqual(out.counts.programs, { added: 0, removed: 0, changed: 1 });
  assert.deepEqual(out.counts.services, { added: 0, removed: 0, changed: 1 });
  assert.equal(out.totalChanges, 3 + 3 + 1 + 1);
  assert.deepEqual(out.notCompared, []);

  assert.equal(out.diff.files.added.items[0].path, "C:\\Program Files\\Acme\\new.dll");
  assert.equal(out.diff.files.removed.items[0].path, "C:\\Program Files\\Acme\\gone.dll");
  assert.equal(out.diff.programs.changed.items[0].before.displayVersion, "1.0.0");
  assert.equal(out.diff.programs.changed.items[0].after.displayVersion, "1.1.0");

  const md = await fsp.readFile(out.artifacts.summary, "utf8");
  assert.match(md, /## Installed programs/);
  assert.match(md, /Acme \(1\.0\.0 → 1\.1\.0\)/);
  const json = JSON.parse(await fsp.readFile(out.artifacts.json, "utf8"));
  assert.equal(json.afterId, "after");

  await fsp.rm(root, { recursive: true, force: true });
});

test("a section captured in only one snapshot is reported as notCompared", async () => {
  const root = await freshRoot();
  await writeSnapshot(root, "b1", { programs: { programs: [] } }); // no files section
  await writeSnapshot(root, "a1", { programs: { programs: [{ id: "X", displayName: "X", displayVersion: "1" }] }, files: { files: [] } });

  const out = await diffSnapshots({ bridgeRoot: root }, "b1", "a1", "2026-06-17T11:00:00.000Z");
  assert.deepEqual(out.counts.programs, { added: 1, removed: 0, changed: 0 });
  assert.ok(out.notCompared.includes("files"));
  assert.ok(out.notCompared.includes("registry"));
  assert.ok(out.notCompared.includes("services"));
  await fsp.rm(root, { recursive: true, force: true });
});

test("file path comparison is case-insensitive", async () => {
  const root = await freshRoot();
  await writeSnapshot(root, "cb", { files: { files: [{ path: "C:\\Foo\\Bar.txt", size: 1, mtime: "t" }] } });
  await writeSnapshot(root, "ca", { files: { files: [{ path: "c:\\foo\\bar.txt", size: 1, mtime: "t" }] } });

  const out = await diffSnapshots({ bridgeRoot: root }, "cb", "ca", "2026-06-17T12:00:00.000Z");
  assert.deepEqual(out.counts.files, { added: 0, removed: 0, changed: 0 });
  await fsp.rm(root, { recursive: true, force: true });
});

test("missing snapshot id throws a clear error", async () => {
  const root = await freshRoot();
  await writeSnapshot(root, "only", { files: { files: [] } });
  await assert.rejects(() => diffSnapshots({ bridgeRoot: root }, "only", "nope", "2026-06-17T13:00:00.000Z"), /Could not read snapshot 'nope'/);
  await fsp.rm(root, { recursive: true, force: true });
});
