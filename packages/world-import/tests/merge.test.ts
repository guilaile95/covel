import { describe, expect, it } from "vitest";
import { chunkChapters } from "../src/chunk.js";
import { splitTxtChapters } from "../src/extract/index.js";
import { FakeExtractionAdapter } from "../src/extraction/fake.js";
import { mergeExtractions } from "../src/merge.js";
import { entryId, formatLocator } from "../src/util.js";
import { FIXTURE_RULES, NOVEL_TXT } from "./fixtures.js";
import { findEntry, runFixturePipeline, TITLE } from "./helpers.js";

async function fixtureBatches(sourceId: string) {
  const adapter = new FakeExtractionAdapter(FIXTURE_RULES);
  const chunks = chunkChapters(sourceId, splitTxtChapters(NOVEL_TXT));
  const batches = [];
  for (const chunk of chunks) {
    const raw = await adapter.extract({
      chunk,
      source: { id: sourceId, file: "白霜之城.txt", kind: "txt" },
      draftTitle: TITLE,
    });
    if (raw.length > 0) batches.push({ chunk, raw });
  }
  return batches;
}

describe("mergeExtractions", () => {
  it("produces one stable entry per entity across all chunks and sources", async () => {
    const { draft } = await runFixturePipeline({});
    const types = new Set(draft.entries.map((e) => e.type));
    expect([...types].sort()).toEqual(
      [
        "character",
        "event",
        "faction",
        "item",
        "location",
        "power",
        "relationship",
        "rule",
      ].sort(),
    );

    const linWan = findEntry(draft, "林晚");
    expect(linWan.id).toBe(entryId("character", "林晚"));
    expect(linWan.aliases).toContain("晚姐");
    // no duplicate entity for the alias
    expect(draft.entries.filter((e) => e.name === "晚姐")).toHaveLength(0);

    // determinism: a fresh run yields byte-identical draft
    const second = await runFixturePipeline({});
    expect(JSON.stringify(second.draft)).toBe(JSON.stringify(draft));
  });

  it("keeps source-backed provenance with file+chapter+paragraph locators", async () => {
    const { draft } = await runFixturePipeline({});
    const linWan = findEntry(draft, "林晚");
    expect(linWan.sourceRefs.length).toBeGreaterThan(1);
    for (const ref of linWan.sourceRefs) {
      expect(ref.sourceId).toMatch(/^src-[0-9a-f]{8}/);
      expect(ref.locator).toMatch(/^chapter:\d+;paragraph:\d+-\d+$/);
    }
  });

  it("marks conflicting claims as conflict instead of picking a winner", async () => {
    const { draft } = await runFixturePipeline({});
    const linWan = findEntry(draft, "林晚");
    expect(linWan.provenanceStatus).toBe("conflict");
    expect(linWan.conflictNotes).toContain("16");
    expect(linWan.conflictNotes).toContain("19");
    // both statements survive in the content
    expect(linWan.content).toContain("十六岁");
    expect(linWan.content).toContain("十九岁");
    // conflict notes reference both locators
    expect(linWan.conflictNotes).toMatch(/chapter:5;paragraph:\d+-\d+/);
    expect(linWan.conflictNotes).toMatch(/chapter:6;paragraph:\d+-\d+/);
  });

  it("never dresses ai-inferred entries as source-backed", async () => {
    const { draft } = await runFixturePipeline({});
    const wuyin = findEntry(draft, "雾隐塔");
    expect(wuyin.provenanceStatus).toBe("ai-inferred");
    expect(wuyin.sourceRefs).toHaveLength(0);

    const shenDuo = findEntry(draft, "沈铎");
    // has source-backed support overall, so the entry is source-backed —
    // but the inferred line keeps an explicit prefix
    expect(shenDuo.provenanceStatus).toBe("source-backed");
    expect(shenDuo.content).toContain("[推断] 沈铎似乎忌惮灰隼商会的商队。");
    expect(shenDuo.sourceRefs.length).toBeGreaterThan(0);
  });

  it("merges an alias-only later mention into the canonical entity", async () => {
    const { draft } = await runFixturePipeline({});
    const linWan = findEntry(draft, "林晚");
    expect(linWan.content).toContain("名册上写着，晚姐十九岁。");
    expect(linWan.aliases).toContain("晚姐");
  });

  it("resolves paragraph-relative refs against chunk offsets", async () => {
    const sourceId = "src-unit";
    const batches = await fixtureBatches(sourceId);
    const draft = mergeExtractions(
      {
        id: "d1",
        title: TITLE,
        sources: [{ id: sourceId, file: "白霜之城.txt", kind: "txt" }],
        summary: "",
      },
      batches,
    );
    const linWan = findEntry(draft, "林晚");
    // 第一章 paragraph 2 is "旅人们低声叫她晚姐" — chunk-relative p2 == chapter p2
    expect(linWan.sourceRefs).toContainEqual(
      expect.objectContaining({
        sourceId,
        locator: formatLocator(1, 2, 2),
        quote: expect.stringContaining("晚姐"),
      }),
    );
  });
});
