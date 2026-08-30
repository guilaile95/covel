import { describe, expect, it } from "vitest";
import {
  createImportJob,
  exportJobCheckpoint,
  getImportProgress,
  restoreImportJob,
  resumeImportJob,
  runImportJob,
} from "../src/job.js";
import type { ExtractionAdapter } from "../src/types.js";
import { FIXTURE_RULES } from "./fixtures.js";
import { FIXTURE_INPUTS, findEntry } from "./helpers.js";
import { FakeExtractionAdapter } from "../src/extraction/fake.js";

/** Adapter that fails on the n-th chunk (0-based) and counts calls. */
function failingAdapter(failOnChunk: number) {
  const inner = new FakeExtractionAdapter(FIXTURE_RULES);
  let calls = 0;
  const adapter: ExtractionAdapter & {
    getCalls(): number;
    setFailOn(n: number): void;
  } = {
    id: "fake-failing",
    setFailOn(n: number) {
      failOnChunk = n;
    },
    getCalls() {
      return calls;
    },
    async extract(request) {
      const index = calls++;
      if (index === failOnChunk) {
        throw new Error(`boom on chunk ${index}`);
      }
      return inner.extract(request);
    },
  };
  return adapter;
}

describe("import job core", () => {
  it("runs the status machine to completed and reports progress", async () => {
    const job = createImportJob({
      title: "白霜之城",
      inputs: FIXTURE_INPUTS,
      adapter: new FakeExtractionAdapter(FIXTURE_RULES),
    });
    expect(getImportProgress(job).status).toBe("queued");

    const result = await runImportJob(job);
    const progress = getImportProgress(job);
    expect(progress.status).toBe("completed");
    expect(progress.totalChunks).toBeGreaterThan(5);
    expect(progress.processedChunks).toBe(progress.totalChunks);
    expect(result.stats.chunks).toBe(progress.totalChunks);
    expect(result.draft.entries.length).toBeGreaterThan(5);
    // completed jobs are idempotent
    const again = await resumeImportJob(job);
    expect(again.draft).toBe(result.draft);
  });

  it("exposes per-chunk progress while extracting", async () => {
    const slowAdapter: ExtractionAdapter = {
      id: "fake-slow",
      async extract(request) {
        await new Promise((r) => setTimeout(r, 15));
        const inner = new FakeExtractionAdapter(FIXTURE_RULES);
        return inner.extract(request);
      },
    };
    const job = createImportJob({
      title: "白霜之城",
      inputs: FIXTURE_INPUTS,
      adapter: slowAdapter,
    });
    const running = runImportJob(job);
    await new Promise((r) => setTimeout(r, 40));
    const mid = getImportProgress(job);
    expect(mid.status).toBe("extracting");
    expect(mid.processedChunks).toBeGreaterThan(0);
    expect(mid.processedChunks).toBeLessThan(mid.totalChunks);
    await running;
  });

  it("fails on extraction errors, resumes from checkpoints without redoing chunks", async () => {
    const adapter = failingAdapter(1);
    const job = createImportJob({
      title: "白霜之城",
      inputs: FIXTURE_INPUTS,
      adapter,
    });

    await expect(runImportJob(job)).rejects.toThrow(/boom on chunk 1/);
    const failed = getImportProgress(job);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("boom on chunk 1");
    expect(failed.processedChunks).toBe(1); // first chunk checkpointed

    adapter.setFailOn(-1); // heal
    const result = await resumeImportJob(job);
    expect(getImportProgress(job).status).toBe("completed");
    // total calls: 1 (ok) + 1 (failed) + remaining chunks — the first chunk
    // was never re-extracted
    expect(adapter.getCalls()).toBe(failed.totalChunks + 1);
    expect(result.draft.entries.length).toBeGreaterThan(5);
  });

  it("restores from an exported checkpoint and skips already-extracted chunks", async () => {
    const broken = failingAdapter(1);
    const job = createImportJob({
      title: "白霜之城",
      id: "baishuang-city",
      inputs: FIXTURE_INPUTS,
      adapter: broken,
    });
    await expect(runImportJob(job)).rejects.toThrow(/boom/);
    const checkpoint = exportJobCheckpoint(job);
    expect(checkpoint.rawBatches.length).toBe(1);
    expect(checkpoint.chunks.length).toBe(getImportProgress(job).totalChunks);

    const healed = failingAdapter(-1);
    const restored = restoreImportJob(checkpoint, { adapter: healed });
    // job identity survives restore
    expect(restored.jobId).toBe(checkpoint.jobId);
    expect(restored.jobId).toBe(job.jobId);
    const result = await runImportJob(restored);
    expect(getImportProgress(restored).status).toBe("completed");
    // only the remaining chunks hit the new adapter
    expect(healed.getCalls()).toBe(checkpoint.chunks.length - 1);
    expect(result.draft.id).toBe("baishuang-city");
    expect(findEntry(result.draft, "林晚").provenanceStatus).toBe("conflict");
  });

  it("materializes the Covel package when exportDir is configured", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "covel-job-export-"));
    try {
      const job = createImportJob({
        title: "白霜之城",
        inputs: FIXTURE_INPUTS,
        adapter: new FakeExtractionAdapter(FIXTURE_RULES),
        exportDir: dir,
      });
      const result = await runImportJob(job);
      expect(result.export?.files).toContain("world.yaml");
      expect(getImportProgress(job).status).toBe("completed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
