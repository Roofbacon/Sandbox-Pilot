// Offline tests for host-side artifact cleanup. A temp bridge is populated with dated entries and
// a fixed "now" so retention is deterministic.
//   run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const { cleanupArtifacts } = await import("../dist/cleanup.js");

const NOW = Date.parse("2026-06-17T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

async function makeDatedDir(parent, name, ageDays) {
  const full = path.join(parent, name);
  await fsp.mkdir(full, { recursive: true });
  const t = new Date(NOW - ageDays * DAY);
  await fsp.utimes(full, t, t);
  return full;
}

async function freshBridge() {
  const root = path.join(os.tmpdir(), "sandbox-cleanup-" + randomUUID());
  const jobs = path.join(root, "artifacts", "jobs");
  await fsp.mkdir(jobs, { recursive: true });
  // a=1d, b=2d, c=10d, d=30d old
  await makeDatedDir(jobs, "job-a", 1);
  await makeDatedDir(jobs, "job-b", 2);
  await makeDatedDir(jobs, "job-c", 10);
  await makeDatedDir(jobs, "job-d", 30);
  return root;
}

function jobsArea(result) {
  return result.areas.find((a) => a.area === "jobs");
}

test("keepLast retains the newest N and removes the rest when no maxAgeDays", async () => {
  const root = await freshBridge();
  const out = await cleanupArtifacts({ bridgeRoot: root }, { keepLast: 2, areas: ["jobs"] }, NOW);
  const jobs = jobsArea(out);
  assert.equal(jobs.scanned, 4);
  assert.deepEqual(jobs.removed.sort(), ["job-c", "job-d"]);
  assert.equal(jobs.kept, 2);
  // c and d are gone, a and b remain
  assert.ok(!(await fsp.stat(path.join(root, "artifacts", "jobs", "job-c")).catch(() => null)));
  assert.ok(await fsp.stat(path.join(root, "artifacts", "jobs", "job-a")));
  await fsp.rm(root, { recursive: true, force: true });
});

test("maxAgeDays only removes entries older than the cutoff", async () => {
  const root = await freshBridge();
  const out = await cleanupArtifacts({ bridgeRoot: root }, { keepLast: 0, maxAgeDays: 7, areas: ["jobs"] }, NOW);
  assert.deepEqual(jobsArea(out).removed.sort(), ["job-c", "job-d"]); // 10d, 30d
  await fsp.rm(root, { recursive: true, force: true });
});

test("keepLast protects the newest even when they exceed maxAgeDays", async () => {
  const root = await freshBridge();
  // All older than 0.5 days, but keepLast=2 must protect the 2 newest.
  const out = await cleanupArtifacts({ bridgeRoot: root }, { keepLast: 2, maxAgeDays: 0.5, areas: ["jobs"] }, NOW);
  assert.deepEqual(jobsArea(out).removed.sort(), ["job-c", "job-d"]);
  await fsp.rm(root, { recursive: true, force: true });
});

test("dryRun reports removals without deleting", async () => {
  const root = await freshBridge();
  const out = await cleanupArtifacts({ bridgeRoot: root }, { keepLast: 1, dryRun: true, areas: ["jobs"] }, NOW);
  assert.equal(out.dryRun, true);
  assert.equal(jobsArea(out).removed.length, 3);
  // nothing actually deleted
  assert.ok(await fsp.stat(path.join(root, "artifacts", "jobs", "job-d")));
  await fsp.rm(root, { recursive: true, force: true });
});

test("guides are skipped unless includeGuides is set", async () => {
  const root = await freshBridge();
  const guides = path.join(root, "guides");
  await fsp.mkdir(guides, { recursive: true });
  await makeDatedDir(guides, "old-guide", 40);

  const without = await cleanupArtifacts({ bridgeRoot: root }, { keepLast: 0 }, NOW);
  assert.equal(without.areas.find((a) => a.area === "guides"), undefined);
  assert.ok(await fsp.stat(path.join(guides, "old-guide")));

  const withGuides = await cleanupArtifacts({ bridgeRoot: root }, { keepLast: 0, includeGuides: true }, NOW);
  assert.deepEqual(withGuides.areas.find((a) => a.area === "guides").removed, ["old-guide"]);
  await fsp.rm(root, { recursive: true, force: true });
});

test("snapshot diffs are pruned separately from snapshot captures", async () => {
  const root = await freshBridge();
  const snaps = path.join(root, "artifacts", "snapshots");
  await makeDatedDir(snaps, "20260101-000000-aaaa", 30);
  await makeDatedDir(path.join(snaps, "diffs"), "diff-old", 30);

  const out = await cleanupArtifacts({ bridgeRoot: root }, { keepLast: 0 }, NOW);
  const snapArea = out.areas.find((a) => a.area === "snapshots");
  const diffArea = out.areas.find((a) => a.area === "snapshotDiffs");
  // 'diffs' must not be treated as a snapshot entry
  assert.deepEqual(snapArea.removed, ["20260101-000000-aaaa"]);
  assert.deepEqual(diffArea.removed, ["diff-old"]);
  await fsp.rm(root, { recursive: true, force: true });
});
