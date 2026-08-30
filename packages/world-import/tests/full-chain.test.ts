import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Full-package load validation through Covel's own server loader.
import { loadSingleWorld } from "@covel/server/src/world-seed-loader.js";
import {
  applyUserEdit,
  loadDraft,
  markAiAccepted,
  markConflictResolved,
  serializeDraft,
} from "../src/contract.js";
import { exportCovelWorldPackage } from "../src/export/covel-package.js";
import {
  LlmExtractionAdapter,
  type ExtractionLlmBackend,
} from "../src/extraction/llm.js";
import {
  createImportJob,
  getImportProgress,
  runImportJob,
} from "../src/job.js";
import { runWorldImport } from "../src/pipeline.js";
import type {
  TextGenerationParams,
  TextGenerationResult,
} from "@covel/ai-provider";
import { FIXTURE_INPUTS, findEntry, TITLE } from "./helpers.js";

let dir: string | undefined;

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function tmpDir(): Promise<string> {
  if (!dir) dir = await mkdtemp(path.join(tmpdir(), "covel-fullchain-"));
  return dir;
}

// ── Scripted fake Covel LLM (JSON in / JSON out, deterministic) ─────

function char(name: string, extra: Record<string, unknown> = {}) {
  return {
    type: "character",
    name,
    content: `${name}的设定。`,
    status: "source-backed",
    paragraphs: [1],
    ...extra,
  };
}

const KEYWORD_RULES: Array<{ anyOf: string[]; make: () => unknown[] }> = [
  {
    anyOf: ["十六岁"],
    make: () => [
      char("林晚", {
        content: "她说自己十六岁。",
        claims: [{ field: "age", value: "16" }],
      }),
    ],
  },
  {
    anyOf: ["十九岁"],
    make: () => [
      char("林晚", {
        content: "名册上写着，晚姐十九岁。",
        claims: [{ field: "age", value: "19" }],
      }),
    ],
  },
  {
    anyOf: ["晚姐"],
    make: () => [char("林晚", { aliases: ["晚姐"] })],
  },
  { anyOf: ["林晚"], make: () => [char("林晚")] },
  { anyOf: ["沈铎"], make: () => [char("沈铎")] },
  {
    anyOf: ["灰隼商会"],
    make: () => [
      {
        type: "faction",
        name: "灰隼商会",
        content: "灰隼商会垄断了白霜城的皮货与盐路。",
        status: "source-backed",
        paragraphs: [1],
      },
    ],
  },
  {
    anyOf: ["白霜城"],
    make: () => [
      {
        type: "location",
        name: "白霜城",
        content: "白霜城坐落在北岭以南的雪谷。",
        status: "source-backed",
        paragraphs: [1],
      },
    ],
  },
  {
    anyOf: ["北岭"],
    make: () => [
      {
        type: "location",
        name: "北岭",
        content: "北岭是白霜城以北的山岭。",
        status: "source-backed",
        paragraphs: [1],
      },
    ],
  },
  {
    anyOf: ["雾气"],
    make: () => [
      {
        type: "location",
        name: "雾隐塔",
        content: "雾气深处或有一座哨塔（推测）。",
        status: "ai-inferred",
      },
    ],
  },
  {
    anyOf: ["玄铁令牌"],
    make: () => [
      {
        type: "item",
        name: "玄铁令牌",
        content: "玄铁令牌是内城信物。",
        status: "source-backed",
        paragraphs: [1],
      },
    ],
  },
  {
    anyOf: ["不得入城主府"],
    make: () => [
      {
        type: "rule",
        name: "令牌禁令",
        content: "凡持玄铁令牌者，不得入城主府。",
        status: "source-backed",
        paragraphs: [1],
      },
    ],
  },
  {
    anyOf: ["霜脉"],
    make: () => [
      {
        type: "power",
        name: "霜脉",
        content: "霜脉让触碰者感知风雪的来向。",
        status: "source-backed",
        paragraphs: [1],
      },
    ],
  },
  {
    anyOf: ["白霜之围"],
    make: () => [
      {
        type: "event",
        name: "白霜之围",
        content: "十年前的白霜之围让白霜城紧闭城门。",
        status: "source-backed",
        paragraphs: [1],
      },
    ],
  },
  {
    anyOf: ["盟友"],
    make: () => [
      {
        type: "relationship",
        name: "林晚与沈铎",
        aliases: ["林晚", "沈铎"],
        content: "林晚与沈铎在雾塔下结为盟友。",
        status: "source-backed",
        paragraphs: [1],
      },
    ],
  },
];

const scriptedBackend: ExtractionLlmBackend = async (
  params: TextGenerationParams,
): Promise<TextGenerationResult> => {
  const requestText = params.messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
  const extractions = KEYWORD_RULES.filter((rule) =>
    rule.anyOf.some((keyword) => requestText.includes(keyword)),
  ).flatMap((rule) => rule.make());
  return {
    text: JSON.stringify({ extractions }),
    finishReason: "stop",
    usage: { inputTokens: requestText.length, outputTokens: 60 },
  };
};

describe("full chain: txt+md+epub → fake Covel LLM → draft → decisions → remerge → package → loader", () => {
  it("keeps every contract field through the whole chain and passes loadSingleWorld", async () => {
    const adapter = new LlmExtractionAdapter({
      backend: scriptedBackend,
      model: "fake-slot",
    });

    // 1. job run → draft + exported package
    const worldDir = path.join(await tmpDir(), "world");
    const job = createImportJob({
      title: TITLE,
      id: "baishuang-city",
      inputs: FIXTURE_INPUTS,
      adapter,
      exportDir: worldDir,
    });
    const jobResult = await runImportJob(job);
    expect(getImportProgress(job).status).toBe("completed");
    expect(jobResult.export?.files).toContain("world.yaml");
    const jobUsage = getImportProgress(job).usage;
    expect(jobUsage.llmCalls).toBe(jobResult.stats.chunks);
    expect(jobUsage.inputTokens).toBeGreaterThan(0);
    expect(jobUsage.outputTokens).toBeGreaterThan(0);

    const types = new Set(jobResult.draft.entries.map((e) => e.type));
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

    // 2. human decisions on the canonical draft
    let edited = serializeDraft(jobResult.draft);
    edited = serializeDraft(
      markAiAccepted(
        markConflictResolved(
          applyUserEdit(
            loadDraft(edited),
            findEntry(jobResult.draft, "沈铎").id,
            {
              content: "人工定稿：沈铎是北岭的守塔人。",
            },
          ),
          findEntry(jobResult.draft, "林晚").id,
        ),
        findEntry(jobResult.draft, "雾隐塔").id,
      ),
    );

    // 3. remerge on top of the decided draft (same fixtures, same adapter)
    const remerged = await runWorldImport({
      title: TITLE,
      id: "baishuang-city",
      inputs: FIXTURE_INPUTS,
      adapter: new LlmExtractionAdapter({
        backend: scriptedBackend,
        model: "fake-slot",
      }),
      existingDraft: loadDraft(edited),
    });

    // 4. export → Covel loader
    const finalDir = path.join(await tmpDir(), "world-final");
    await exportCovelWorldPackage(remerged.draft, finalDir);
    const record = await loadSingleWorld(finalDir);
    expect(record).not.toBeNull();
    expect(record?.id).toBe("baishuang-city");
    expect(record?.lore).toContain("白霜之城");

    // 5. reload the final draft — every decision field survived
    const finalDraft = loadDraft(serializeDraft(remerged.draft));
    const shenDuo = findEntry(finalDraft, "沈铎");
    expect(shenDuo.userEdited).toBe(true);
    expect(shenDuo.content).toBe("人工定稿：沈铎是北岭的守塔人。");
    const linWan = findEntry(finalDraft, "林晚");
    expect(linWan.conflictResolved).toBe(true);
    expect(linWan.provenanceStatus).not.toBe("conflict");
    expect(findEntry(finalDraft, "雾隐塔").aiAccepted).toBe(true);
    expect(linWan.sourceRefs[0].quote).toBeTruthy();
  }, 60000);
});
