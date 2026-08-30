/**
 * In-memory import job registry.
 *
 * The pipeline itself is @covel/world-import's runWorldImport; this module
 * only tracks job lifecycle and staged progress so the review UI can poll.
 * Jobs live for the process lifetime (capped) — a server restart drops
 * them, which is acceptable for a user-watched progress bar.
 */

import {
  chunkChapters,
  extractDocument,
  runWorldImport,
  FakeExtractionAdapter,
  type ImportInput,
  type WorldImportResult,
  type ExtractionAdapter,
  type ExtractionRequest,
  type RawExtraction,
} from "@covel/world-import";
import { FAKE_RULES } from "./fake-rules.js";

export type ImportJobStatus = "running" | "done" | "error";

export interface ImportJob {
  readonly id: string;
  status: ImportJobStatus;
  /** parsing → extracting → done/error. */
  stage: "parsing" | "extracting";
  chunksDone: number;
  chunksTotal: number;
  stats?: WorldImportResult["stats"];
  draft?: WorldImportResult["draft"];
  error?: string;
  createdAt: string;
}

const MAX_FINISHED_JOBS = 20;

export interface ImportRequest {
  title: string;
  inputs: ImportInput[];
}

export function createImportJobRunner() {
  const jobs = new Map<string, ImportJob>();

  function gc() {
    const finished = [...jobs.values()]
      .filter((job) => job.status !== "running")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (finished.length > MAX_FINISHED_JOBS) {
      const oldest = finished.shift();
      if (oldest) jobs.delete(oldest.id);
    }
  }

  function start(request: ImportRequest): ImportJob {
    const job: ImportJob = {
      id: crypto.randomUUID(),
      status: "running",
      stage: "parsing",
      chunksDone: 0,
      chunksTotal: 0,
      createdAt: new Date().toISOString(),
    };
    jobs.set(job.id, job);
    gc();
    void run(request, job).catch((error: unknown) => {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
    });
    return job;
  }

  async function run(request: ImportRequest, job: ImportJob) {
    // Pre-pass: parse + chunk once to know the total, so the progress bar
    // has a denominator. Pure functions — the pipeline repeats them
    // internally on the same inputs.
    let chunksTotal = 0;
    for (const input of request.inputs) {
      const document = extractDocument(input.file, input.bytes);
      chunksTotal += chunkChapters(
        `count-${input.file}`,
        document.chapters,
      ).length;
    }
    job.chunksTotal = chunksTotal;
    job.stage = "extracting";

    // Progress wrapper around the package's adapter — counts completed
    // chunks without touching pipeline internals.
    const inner = new FakeExtractionAdapter(FAKE_RULES);
    const progressAdapter: ExtractionAdapter = {
      id: inner.id,
      extract: async (request: ExtractionRequest): Promise<RawExtraction[]> => {
        const raw = await inner.extract(request);
        job.chunksDone += 1;
        return raw;
      },
    };

    const result = await runWorldImport({
      title: request.title,
      inputs: request.inputs,
      adapter: progressAdapter,
    });

    job.draft = result.draft;
    job.stats = result.stats;
    job.status = "done";
    gc();
  }

  return {
    start,
    get(id: string): ImportJob | undefined {
      return jobs.get(id);
    },
    clearFinished() {
      for (const [id, job] of jobs) {
        if (job.status !== "running") jobs.delete(id);
      }
    },
  };
}
