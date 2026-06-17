import * as fsp from "node:fs/promises";
import * as path from "node:path";

// Host-side artifact retention. The bridge is a shared host folder, so the server can prune old
// run artifacts directly (even when the guest agent isn't running). Each area keeps the newest
// `keepLast` entries and, beyond that, removes entries older than `maxAgeDays` (or all of them if
// maxAgeDays is unset). Entries are guide/run folders (or screenshot files), keyed by mtime.

export interface CleanupOptions {
  maxAgeDays?: number;
  keepLast?: number;
  includeGuides?: boolean;
  areas?: string[];
  dryRun?: boolean;
}

export interface CleanupDeps {
  bridgeRoot: string;
}

interface AreaSpec {
  name: string;
  dir: string;
  kind: "dirs" | "files";
  exclude?: string[];
  optIn?: boolean;
}

function areaSpecs(bridgeRoot: string): AreaSpec[] {
  const artifacts = path.join(bridgeRoot, "artifacts");
  return [
    { name: "jobs", dir: path.join(artifacts, "jobs"), kind: "dirs" },
    { name: "testplans", dir: path.join(artifacts, "testplans"), kind: "dirs" },
    { name: "snapshots", dir: path.join(artifacts, "snapshots"), kind: "dirs", exclude: ["diffs"] },
    { name: "snapshotDiffs", dir: path.join(artifacts, "snapshots", "diffs"), kind: "dirs" },
    { name: "screenshots", dir: path.join(artifacts, "screenshots"), kind: "files" },
    { name: "guides", dir: path.join(bridgeRoot, "guides"), kind: "dirs", optIn: true },
  ];
}

async function entriesWithMtime(spec: AreaSpec): Promise<Array<{ name: string; full: string; mtimeMs: number }>> {
  let dirents;
  try {
    dirents = await fsp.readdir(spec.dir, { withFileTypes: true });
  } catch {
    return []; // area doesn't exist yet
  }
  const out = [];
  for (const d of dirents) {
    if (spec.exclude?.includes(d.name)) continue;
    if (spec.kind === "dirs" && !d.isDirectory()) continue;
    if (spec.kind === "files" && !d.isFile()) continue;
    const full = path.join(spec.dir, d.name);
    try {
      const st = await fsp.stat(full);
      out.push({ name: d.name, full, mtimeMs: st.mtimeMs });
    } catch {
      // raced away; ignore
    }
  }
  return out;
}

export async function cleanupArtifacts(deps: CleanupDeps, opts: CleanupOptions, nowMs: number): Promise<any> {
  const keepLast = opts.keepLast ?? 20;
  const maxAgeMs = opts.maxAgeDays != null ? opts.maxAgeDays * 24 * 60 * 60 * 1000 : null;
  const dryRun = !!opts.dryRun;

  const specs = areaSpecs(deps.bridgeRoot).filter((s) => {
    if (s.optIn && s.name === "guides" && !opts.includeGuides) return false;
    if (opts.areas && !opts.areas.includes(s.name)) return false;
    return true;
  });

  const areaResults = [];
  let totalRemoved = 0;
  for (const spec of specs) {
    const entries = (await entriesWithMtime(spec)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const removed: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (i < keepLast) continue; // always keep the newest keepLast
      const ageMs = nowMs - entries[i].mtimeMs;
      if (maxAgeMs != null && ageMs <= maxAgeMs) continue; // not old enough
      if (!dryRun) {
        await fsp.rm(entries[i].full, { recursive: true, force: true });
      }
      removed.push(entries[i].name);
    }
    totalRemoved += removed.length;
    areaResults.push({ area: spec.name, scanned: entries.length, kept: entries.length - removed.length, removed });
  }

  return { dryRun, keepLast, maxAgeDays: opts.maxAgeDays ?? null, totalRemoved, areas: areaResults };
}
