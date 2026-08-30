import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Full-package load validation through Covel's own server loader.
import { loadSingleWorld } from "@covel/server/src/world-seed-loader.js";
import { exportCovelWorldPackage } from "../src/export/covel-package.js";
import { findEntry, runFixturePipeline } from "./helpers.js";

let dir: string | undefined;

async function tmpDir(): Promise<string> {
  if (!dir) dir = await mkdtemp(path.join(tmpdir(), "covel-load-"));
  return dir;
}

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("fixture pipeline end-to-end", () => {
  it("produces a draft that exports into a Covel world package which loadSingleWorld accepts", async () => {
    const { draft, stats } = await runFixturePipeline({});
    const worldDir = path.join(await tmpDir(), "world");
    await exportCovelWorldPackage(draft, worldDir);

    const record = await loadSingleWorld(worldDir);
    expect(record).not.toBeNull();
    expect(record?.id).toBe(draft.id);
    // WORLD.md became the world's default lore
    expect(record?.lore).toContain("白霜之城");
    // dimensions routed through the worldData descriptor land in metadata
    const dimensions = (record?.metadata?.dimensions ?? {}) as Record<
      string,
      any
    >;
    const regionNames = (dimensions.geography?.regions ?? []).map(
      (r: { name: string }) => r.name,
    );
    expect(regionNames).toEqual(expect.arrayContaining(["白霜城", "北岭"]));
    expect(
      (dimensions.factions ?? []).map((f: { name: string }) => f.name),
    ).toContain("灰隼商会");

    expect(stats.entries).toBeGreaterThan(5);
    expect(stats.conflicts).toBe(1);
    expect(stats.aiInferred).toBeGreaterThan(0);
  }, 30000);

  it("is deterministic: same fixtures → byte-identical draft", async () => {
    const a = await runFixturePipeline({});
    const b = await runFixturePipeline({});
    expect(JSON.stringify(a.draft)).toBe(JSON.stringify(b.draft));
    expect(JSON.stringify(a.stats)).toBe(JSON.stringify(b.stats));
  });

  it("aggregates provenance across txt, md and epub sources", async () => {
    const { draft } = await runFixturePipeline({});
    const linWan = findEntry(draft, "林晚");
    const sourceIds = new Set(linWan.sourceRefs.map((r) => r.sourceId));
    expect(sourceIds.size).toBeGreaterThanOrEqual(2); // txt + md (+ epub)

    const shenDuo = findEntry(draft, "沈铎");
    expect(
      new Set(shenDuo.sourceRefs.map((r) => r.sourceId)).size,
    ).toBeGreaterThanOrEqual(2);
    // every source contributed
    expect(draft.sources.map((s) => s.kind).sort()).toEqual([
      "epub",
      "md",
      "txt",
    ]);
  });
});
