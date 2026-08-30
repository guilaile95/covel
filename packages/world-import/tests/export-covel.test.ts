import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  validateDimensions,
  validateWorldManifest,
  worldDataDescriptorSchema,
} from "@covel/shared";
import { exportCovelWorldPackage } from "../src/export/covel-package.js";
import { findEntry, runFixturePipeline } from "./helpers.js";

let dir: string | undefined;

async function tmpDir(): Promise<string> {
  if (!dir) dir = await mkdtemp(path.join(tmpdir(), "covel-export-"));
  return dir;
}

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function exportFixtureDraft() {
  const { draft } = await runFixturePipeline({});
  const worldDir = path.join(await tmpDir(), "pkg");
  return {
    draft,
    summary: await exportCovelWorldPackage(draft, worldDir),
    worldDir,
  };
}

describe("exportCovelWorldPackage", () => {
  it("writes the core Covel package files", async () => {
    const { summary } = await exportFixtureDraft();
    for (const file of [
      "world.yaml",
      "WORLD.md",
      "data/world.data.yaml",
      "data/dimensions.yaml",
      "data/lorebook.yaml",
      "characters/main-cast.json",
    ]) {
      expect(summary.files).toContain(file);
    }
    expect(summary.files.some((f) => f.startsWith("data/rules/"))).toBe(true);
  });

  it("produces a manifest that passes validateWorldManifest", async () => {
    const { worldDir } = await exportFixtureDraft();
    const manifest = parseYaml(
      await readFile(path.join(worldDir, "world.yaml"), "utf-8"),
    );
    const result = validateWorldManifest(manifest);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    // derived ids must satisfy Covel's slug rule
    expect(manifest.id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it("produces dimensions that pass validateDimensions", async () => {
    const { worldDir } = await exportFixtureDraft();
    const dimensions = parseYaml(
      await readFile(path.join(worldDir, "data/dimensions.yaml"), "utf-8"),
    );
    const result = validateDimensions(dimensions);
    expect(result.valid).toBe(true);
    expect(result.errors ?? []).toEqual([]);
    expect(
      dimensions.geography.regions.map((r: { name: string }) => r.name),
    ).toEqual(expect.arrayContaining(["白霜城", "北岭", "雾隐塔"]));
    expect(dimensions.factions[0].id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(dimensions.powerSystem.rules.length).toBeGreaterThan(0);
    expect(dimensions.history[0].significance).toBe("minor");
  });

  it("produces a world.data.yaml descriptor that passes the frozen schema", async () => {
    const { worldDir } = await exportFixtureDraft();
    const descriptor = parseYaml(
      await readFile(path.join(worldDir, "data/world.data.yaml"), "utf-8"),
    );
    const parsed = worldDataDescriptorSchema.safeParse(descriptor);
    expect(parsed.success).toBe(true);
  });

  it("keeps provenance markers in the lorebook and cast ids valid", async () => {
    const { draft, worldDir } = await exportFixtureDraft();
    const lorebook = parseYaml(
      await readFile(path.join(worldDir, "data/lorebook.yaml"), "utf-8"),
    );
    const byId = new Map<
      string,
      { id: string; content: string; keys: string[] }
    >(lorebook.map((e: { id: string }) => [e.id, e]));

    const linWan = findEntry(draft, "林晚");
    expect(byId.get(linWan.id)?.content).toMatch(/^\[冲突待解\]/);
    expect(byId.get(linWan.id)?.keys).toContain("晚姐");

    const wuyin = findEntry(draft, "雾隐塔");
    expect(byId.get(wuyin.id)?.content).toMatch(/^\[推断\]/);

    const cast = JSON.parse(
      await readFile(path.join(worldDir, "characters/main-cast.json"), "utf-8"),
    );
    expect(cast.length).toBeGreaterThan(0);
    for (const blueprint of cast) {
      expect(blueprint.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
      expect(blueprint.schemaVersion).toBe(1);
    }
    expect(
      cast.find((b: { id: string }) => b.id === linWan.id).aliases,
    ).toContain("晚姐");
  });

  it("is byte-deterministic for the same draft", async () => {
    const { draft, worldDir } = await exportFixtureDraft();
    await exportCovelWorldPackage(draft, path.join(await tmpDir(), "pkg2"));
    for (const file of [
      "world.yaml",
      "WORLD.md",
      "data/lorebook.yaml",
      "data/dimensions.yaml",
    ]) {
      const a = await readFile(path.join(worldDir, file), "utf-8");
      const b = await readFile(
        path.join(await tmpDir(), "pkg2", file),
        "utf-8",
      );
      expect(a).toBe(b);
    }
  });

  it("marks provenance in WORLD.md for human review", async () => {
    const { worldDir } = await exportFixtureDraft();
    const md = await readFile(path.join(worldDir, "WORLD.md"), "utf-8");
    expect(md).toContain("# 白霜之城");
    expect(md).toContain("冲突待解");
    expect(md).toContain("推断");
  });
});
