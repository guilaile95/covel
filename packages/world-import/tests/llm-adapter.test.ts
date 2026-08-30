import { describe, expect, it } from "vitest";
import {
  ExtractionOutputError,
  LlmExtractionAdapter,
  validateExtractions,
} from "../src/extraction/llm.js";
import {
  createFakeExtractionBackend,
  extractionResponse,
} from "../src/extraction/fake-llm.js";
import type { Chunk } from "../src/types.js";

function makeChunk(paragraphs: string[]): Chunk {
  return {
    id: "src-x-c0-p0",
    sourceId: "src-x",
    chapterIndex: 0,
    chapterTitle: "第一章",
    partIndex: 0,
    partCount: 1,
    startParagraph: 1,
    endParagraph: paragraphs.length,
    text: paragraphs.join("\n"),
  };
}

const CHUNK = makeChunk([
  "林晚踏进白霜城，怀里揣着玄铁令牌。",
  "守卫说：凡持玄铁令牌者，不得入城主府。",
  "她说自己十六岁。",
]);

const GOOD_EXTRACTIONS = [
  {
    type: "character",
    name: "林晚",
    aliases: ["晚姐"],
    content: "白霜城斥候。",
    status: "source-backed",
    paragraphs: [1],
    claims: [{ field: "age", value: "16" }],
  },
  {
    type: "item",
    name: "玄铁令牌",
    content: "进入内城的信物。",
    status: "source-backed",
    paragraphs: [1],
  },
  {
    type: "location",
    name: "雾隐塔",
    content: "或有一座被遗忘的哨塔。",
    status: "ai-inferred",
  },
];

const REQUEST = {
  chunk: CHUNK,
  source: { id: "src-x", file: "novel.txt", kind: "txt" } as const,
  draftTitle: "白霜之城",
};

describe("LlmExtractionAdapter", () => {
  it("extracts all 8 entity types from well-formed model JSON", async () => {
    const eightTypes = [
      "character",
      "faction",
      "location",
      "item",
      "rule",
      "power",
      "event",
      "relationship",
    ].map((type, i) => ({
      type,
      name: `实体${i}`,
      content: `内容${i}`,
      status: "source-backed",
      paragraphs: [1],
    }));
    const backend = createFakeExtractionBackend([
      extractionResponse(eightTypes),
    ]);
    const adapter = new LlmExtractionAdapter({ backend, model: "fake-slot" });

    const raw = await adapter.extract(REQUEST);
    expect(raw.map((r) => r.type)).toEqual([
      "character",
      "faction",
      "location",
      "item",
      "rule",
      "power",
      "event",
      "relationship",
    ]);
  });

  it("strips code fences and accepts a bare top-level array", async () => {
    const backend = createFakeExtractionBackend([
      { text: "```json\n" + JSON.stringify(GOOD_EXTRACTIONS) + "\n```" },
    ]);
    const adapter = new LlmExtractionAdapter({ backend, model: "fake-slot" });
    const raw = await adapter.extract(REQUEST);
    expect(raw).toHaveLength(3);
    expect(raw[0].name).toBe("林晚");
  });

  it("rejects source-backed entries without paragraphs via a bounded repair loop", async () => {
    const broken = [
      {
        type: "character",
        name: "林晚",
        content: "斥候。",
        status: "source-backed",
      },
    ];
    const backend = createFakeExtractionBackend([
      { call: 0, text: JSON.stringify({ extractions: broken }) },
      { call: 1, text: JSON.stringify({ extractions: GOOD_EXTRACTIONS }) },
    ]);
    const adapter = new LlmExtractionAdapter({ backend, model: "fake-slot" });
    const raw = await adapter.extract(REQUEST);
    expect(backend.getCalls()).toBe(2); // 1 initial + 1 repair
    expect(raw).toHaveLength(3);
    // the repair message must quote the original output and the violation
    expect(backend.getRequests()[1]).toContain("不合法");
    expect(backend.getRequests()[1]).toContain("paragraphs");
  });

  it("fails loudly when output is still invalid after the repair budget", async () => {
    const backend = createFakeExtractionBackend([{ text: "这不是 JSON" }]);
    const adapter = new LlmExtractionAdapter({
      backend,
      model: "fake-slot",
      maxRepairs: 2,
    });
    await expect(adapter.extract(REQUEST)).rejects.toBeInstanceOf(
      ExtractionOutputError,
    );
    expect(backend.getCalls()).toBe(3); // 1 + 2 repairs, then hard failure
  });

  it("rejects fabricated paragraph sources (out of range)", async () => {
    const lying = [
      {
        type: "character",
        name: "林晚",
        content: "斥候。",
        status: "source-backed",
        paragraphs: [99],
      },
    ];
    const backend = createFakeExtractionBackend([
      { call: 0, text: JSON.stringify({ extractions: lying }) },
      { call: 1, text: JSON.stringify({ extractions: GOOD_EXTRACTIONS }) },
    ]);
    const adapter = new LlmExtractionAdapter({ backend, model: "fake-slot" });
    const raw = await adapter.extract(REQUEST);
    expect(backend.getCalls()).toBe(2);
    expect(raw[0].paragraphs).toEqual([1]);
  });

  it("strips paragraphs from ai-inferred entries (no fabricated provenance)", async () => {
    const backend = createFakeExtractionBackend([
      {
        text: JSON.stringify({
          extractions: [
            {
              type: "location",
              name: "雾隐塔",
              content: "推断。",
              status: "ai-inferred",
              paragraphs: [1],
            },
          ],
        }),
      },
    ]);
    const adapter = new LlmExtractionAdapter({ backend, model: "fake-slot" });
    const raw = await adapter.extract(REQUEST);
    expect(raw[0].status).toBe("ai-inferred");
    expect(raw[0].paragraphs).toBeUndefined();
  });

  it("accumulates usage across calls", async () => {
    const backend = createFakeExtractionBackend([
      { call: 0, text: "坏", usage: { inputTokens: 10, outputTokens: 5 } },
      { call: 1, text: "又坏", usage: { inputTokens: 12, outputTokens: 6 } },
      {
        call: 2,
        text: JSON.stringify({ extractions: GOOD_EXTRACTIONS }),
        usage: { inputTokens: 14, outputTokens: 8 },
      },
    ]);
    const adapter = new LlmExtractionAdapter({ backend, model: "fake-slot" });
    await adapter.extract(REQUEST);
    expect(adapter.getUsage()).toEqual({
      llmCalls: 3,
      inputTokens: 36,
      outputTokens: 19,
    });
  });

  it("sends paragraph-numbered chunk text and the 8-type rule in the prompt", async () => {
    const backend = createFakeExtractionBackend([
      { text: JSON.stringify({ extractions: [] }) },
    ]);
    const adapter = new LlmExtractionAdapter({ backend, model: "fake-slot" });
    await adapter.extract(REQUEST);
    const requestText = backend.getRequests()[0];
    expect(requestText).toContain("[P1] 林晚踏进白霜城");
    expect(requestText).toContain("[P3] 她说自己十六岁。");
    expect(requestText).toContain("relationship");
    expect(requestText).toContain("不得伪造段落来源");
  });
});

describe("validateExtractions", () => {
  it("rejects unknown types and empty names", () => {
    const result = validateExtractions(
      [
        { type: "dragon", name: "x", content: "c", status: "ai-inferred" },
        { type: "item", name: "", content: "c", status: "ai-inferred" },
      ],
      3,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBe(2);
  });
});
