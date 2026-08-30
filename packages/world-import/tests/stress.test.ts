import { describe, expect, it } from "vitest";
import {
  FakeExtractionAdapter,
  type FakeRule,
} from "../src/extraction/fake.js";
import { runWorldImport } from "../src/pipeline.js";
import { findEntry } from "./helpers.js";
import type { ImportInput } from "../src/pipeline.js";

/**
 * Deterministic synthetic long-novel generator. Each chapter is ~600 CJK
 * chars; entities, aliases, repeated rules, conflicts and inference
 * triggers recur on fixed cycles so merge behaviour is assertable.
 * Nothing is written to disk or committed.
 */
function buildSyntheticNovel(targetBytes: number): string {
  const lines: string[] = [];
  let chapter = 0;
  let bytes = 0;
  while (bytes < targetBytes) {
    chapter += 1;
    const head = `第${chapter}章 循环之城\n`;
    const body: string[] = [];
    body.push("林晚在白霜城的街巷里穿行，斗篷上落满了雪。");
    if (chapter % 3 === 0) body.push("街边的孩子们都认得晚姐。");
    body.push("沈铎从北岭的方向进城，肩上落着霜。");
    body.push("灰隼商会的车队堵在城门口，不肯让路。");
    body.push("她摸了摸怀里的玄铁令牌，没有拿出来。");
    body.push("白霜城宵禁：戌时之后不得夜出，违者逐出城去。");
    if (chapter % 25 === 0) {
      body.push(
        chapter % 50 === 0
          ? "她对自己说，我十九岁。"
          : "她对自己说，我十六岁。",
      );
    }
    body.push("北岭的雾气漫过城墙，像一层灰纱。");
    const chapterText = head + body.join("\n") + "\n\n";
    bytes += Buffer.byteLength(chapterText, "utf-8");
    lines.push(chapterText);
  }
  return lines.join("");
}

const STRESS_RULES: FakeRule[] = [
  {
    anyOf: ["林晚"],
    emit: [
      {
        type: "character",
        name: "林晚",
        aliases: ["晚姐"],
        content: "林晚是白霜城的斥候。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["十六岁"],
    emit: [
      {
        type: "character",
        name: "林晚",
        content: "她说自己十六岁。",
        paragraphs: "match",
        claims: [{ field: "age", value: "16" }],
      },
    ],
  },
  {
    anyOf: ["十九岁"],
    emit: [
      {
        type: "character",
        name: "林晚",
        content: "名册上写着十九岁。",
        paragraphs: "match",
        claims: [{ field: "age", value: "19" }],
      },
    ],
  },
  {
    anyOf: ["沈铎"],
    emit: [
      {
        type: "character",
        name: "沈铎",
        content: "沈铎是北岭的守塔人。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["灰隼商会"],
    emit: [
      {
        type: "faction",
        name: "灰隼商会",
        content: "灰隼商会垄断商路。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["玄铁令牌"],
    emit: [
      {
        type: "item",
        name: "玄铁令牌",
        content: "玄铁令牌是内城信物。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["不得夜出"],
    emit: [
      {
        type: "rule",
        name: "宵禁",
        content: "白霜城宵禁：戌时之后不得夜出。",
        paragraphs: "match",
      },
    ],
  },
  {
    anyOf: ["雾气"],
    emit: [
      {
        type: "location",
        name: "雾隐塔",
        status: "ai-inferred",
        content: "雾气深处或有一座哨塔（推断）。",
      },
    ],
  },
];

interface RecordingAdapter {
  maxChunkChars: number;
  calls: number;
}

async function runStress(inputs: ImportInput[], maxChunkChars: number) {
  const rules = new FakeExtractionAdapter(STRESS_RULES);
  const recorder: RecordingAdapter = { maxChunkChars: 0, calls: 0 };
  const wrapped = {
    id: "fake",
    async extract(request: Parameters<FakeExtractionAdapter["extract"]>[0]) {
      recorder.calls += 1;
      recorder.maxChunkChars = Math.max(
        recorder.maxChunkChars,
        request.chunk.text.length,
      );
      return rules.extract(request);
    },
  };
  const started = Date.now();
  const { draft, stats } = await runWorldImport({
    title: "循环之城",
    inputs,
    adapter: wrapped,
    maxChunkChars,
  });
  return { draft, stats, recorder, elapsedMs: Date.now() - started };
}

describe("long-novel stress", () => {
  it("1MB txt: chunks stay under budget, entity merges across hundreds of chunks", async () => {
    const text = buildSyntheticNovel(1024 * 1024);
    const { draft, stats, recorder, elapsedMs } = await runStress(
      [{ file: "循环之城.txt", bytes: new TextEncoder().encode(text) }],
      16000,
    );

    // the adapter never saw more than one chunk at a time
    expect(recorder.maxChunkChars).toBeLessThanOrEqual(16000);
    expect(stats.chunks).toBeGreaterThan(100);
    expect(recorder.calls).toBe(stats.chunks);

    const linWan = findEntry(draft, "林晚");
    expect(linWan.sourceRefs.length).toBeGreaterThan(500); // across hundreds of chunks
    expect(linWan.aliases).toContain("晚姐");
    expect(linWan.provenanceStatus).toBe("conflict"); // 16 vs 19 both seen

    const curfew = findEntry(draft, "宵禁");
    expect(curfew.sourceRefs.length).toBeGreaterThan(500); // same rule restated everywhere

    console.log(
      `[stress 1MB] bytes=${text.length} chunks=${stats.chunks} entries=${stats.entries} adapterCalls=${recorder.calls} maxChunkChars=${recorder.maxChunkChars} elapsedMs=${elapsedMs}`,
    );
  }, 120000);

  it("5MB txt across two files: no whole-novel submission, deterministic merge", async () => {
    const text = buildSyntheticNovel(5 * 1024 * 1024);
    const half = Math.floor(text.length / 2);
    const inputs: ImportInput[] = [
      {
        file: "循环之城·上.txt",
        bytes: new TextEncoder().encode(text.slice(0, half)),
      },
      {
        file: "循环之城·下.txt",
        bytes: new TextEncoder().encode(text.slice(half)),
      },
    ];
    const { draft, stats, recorder, elapsedMs } = await runStress(
      inputs,
      32000,
    );

    expect(recorder.maxChunkChars).toBeLessThanOrEqual(32000);
    expect(stats.sources).toBe(2);
    expect(stats.chunks).toBeGreaterThan(300);
    expect(draft.entries.filter((e) => e.name === "林晚")).toHaveLength(1);
    expect(findEntry(draft, "雾隐塔").provenanceStatus).toBe("ai-inferred");

    console.log(
      `[stress 5MB] bytes=${text.length} chunks=${stats.chunks} entries=${stats.entries} adapterCalls=${recorder.calls} maxChunkChars=${recorder.maxChunkChars} elapsedMs=${elapsedMs}`,
    );
  }, 300000);

  it("is deterministic at 1MB scale", async () => {
    const text = buildSyntheticNovel(1024 * 1024);
    const input: ImportInput[] = [
      { file: "循环之城.txt", bytes: new TextEncoder().encode(text) },
    ];
    const a = await runStress(input, 16000);
    const b = await runStress(input, 16000);
    expect(JSON.stringify(a.draft)).toBe(JSON.stringify(b.draft));
  }, 240000);
});
