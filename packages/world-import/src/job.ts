/**
 * Import Job Core — a resumable, task-level wrapper around the pipeline.
 * No HTTP, no distributed queue: one in-process job object with a status
 * machine, chunk-level checkpoints and usage reporting, so a future UI/API
 * layer can drive the same pipeline without rewriting it.
 *
 *   queued → extracting → merging → materializing → completed
 *      ↘ failed (resume continues from the last checkpoint)
 *
 * - extracting checkpoints per chunk: a resumed job never re-extracts a
 *   chunk that already produced raw extractions;
 * - usage comes from adapters implementing UsageReportingAdapter
 *   (LlmExtractionAdapter does); other adapters report zero;
 * - exportJobCheckpoint() serializes everything EXCEPT the raw input bytes
 *   — resumeImportJob can continue past `extracting` without them, but a
 *   checkpoint that has not finished extracting needs the inputs again.
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { chunkChapters } from "./chunk.js";
import { extractDocument } from "./extract/index.js";
import {
  exportCovelWorldPackage,
  type ExportedPackageSummary,
} from "./export/covel-package.js";
import {
  mergeExtractions,
  type ExtractionBatch,
  type MergeOptions,
} from "./merge.js";
import type {
  Chunk,
  DraftSource,
  ExtractionAdapter,
  RawExtraction,
  WorldImportDraft,
} from "./types.js";
import type { AdapterUsage, UsageReportingAdapter } from "./extraction/llm.js";
import type { ImportInput, ImportStats } from "./pipeline.js";
import { buildDraftMeta, countChapters } from "./draft-meta.js";
import { hash8 } from "./util.js";

export type ImportJobStatus =
  | "queued"
  | "extracting"
  | "merging"
  | "materializing"
  | "completed"
  | "failed";

export interface ImportJobConfig {
  title: string;
  /** Explicit Covel world id; default derives from title + inputs. */
  id?: string;
  inputs: ImportInput[];
  adapter: ExtractionAdapter;
  maxChunkChars?: number;
  existingDraft?: WorldImportDraft;
  /** When set, the materializing phase writes the Covel package here. */
  exportDir?: string;
}

export interface ImportJobUsage extends AdapterUsage {
  durationMs: number;
}

export interface ImportProgress {
  jobId: string;
  status: ImportJobStatus;
  totalChunks: number;
  processedChunks: number;
  error?: string;
  usage: ImportJobUsage;
}

export interface ImportJobResult {
  draft: WorldImportDraft;
  stats: ImportStats;
  export?: ExportedPackageSummary;
}

const ZERO_USAGE: ImportJobUsage = {
  llmCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 0,
};

export class ImportJob {
  readonly jobId: string;

  private status: ImportJobStatus = "queued";
  private chunks: Chunk[] | undefined;
  private sources: DraftSource[] | undefined;
  private readonly rawByChunk = new Map<string, RawExtraction[]>();
  private extractionCount = 0;
  private draft: WorldImportDraft | undefined;
  private exported: ExportedPackageSummary | undefined;
  private result: ImportJobResult | undefined;
  private error: string | undefined;
  private usage: ImportJobUsage = { ...ZERO_USAGE };

  constructor(private readonly config: ImportJobConfig) {
    this.jobId = `job-${randomUUID()}`;
  }

  getProgress(): ImportProgress {
    const chunks = this.chunks;
    return {
      jobId: this.jobId,
      status: this.status,
      totalChunks: chunks ? chunks.length : 0,
      processedChunks: this.rawByChunk.size,
      ...(this.error ? { error: this.error } : {}),
      usage: { ...this.usage },
    };
  }

  getStatus(): ImportJobStatus {
    return this.status;
  }

  /** Run (or continue running) the job to completion. */
  async run(): Promise<ImportJobResult> {
    if (this.status === "completed" && this.result) return this.result;
    if (this.status === "failed" && !this.error) {
      throw new Error("import job is failed without an error");
    }

    try {
      if (
        this.status === "queued" ||
        this.status === "failed" ||
        this.status === "extracting"
      ) {
        await this.runExtracting();
      }
      if (this.status === "merging") this.runMerging();
      if (this.status === "materializing") await this.runMaterializing();
    } catch (error) {
      this.status = "failed";
      this.error = error instanceof Error ? error.message : String(error);
      throw error;
    }

    if (this.status !== "completed" || !this.result) {
      throw new Error(`import job ended in unexpected status ${this.status}`);
    }
    return this.result;
  }

  /** Alias of run() with resume semantics: failed jobs continue, completed jobs are idempotent. */
  async resume(): Promise<ImportJobResult> {
    return this.run();
  }

  private async runExtracting(): Promise<void> {
    this.status = "extracting";
    if (!this.sources || !this.chunks) this.prepareChunks();

    const chunks = this.chunks!;
    const sources = this.sources!;
    const startedAt = Date.now();

    for (const chunk of chunks) {
      if (this.rawByChunk.has(chunk.id)) continue; // checkpoint hit
      const source = sources.find((s) => s.id === chunk.sourceId);
      if (!source) throw new Error(`job: chunk ${chunk.id} has no source`);
      const raw = await this.config.adapter.extract({
        chunk,
        source,
        draftTitle: this.config.title,
      });
      this.rawByChunk.set(chunk.id, raw);
      this.extractionCount += raw.length;
      this.absorbUsage(startedAt);
    }
    this.absorbUsage(startedAt);
    this.status = "merging";
  }

  private runMerging(): void {
    this.status = "merging";
    if (!this.sources || !this.chunks) {
      throw new Error(
        "job: merging requires chunks (provide inputs or a checkpoint)",
      );
    }
    const batches: ExtractionBatch[] = [];
    for (const chunk of this.chunks) {
      const raw = this.rawByChunk.get(chunk.id);
      if (raw && raw.length > 0) batches.push({ chunk, raw });
    }

    const meta = buildDraftMeta({
      title: this.config.title,
      explicitId: this.config.id,
      sources: this.sources,
      chunks: this.chunks,
      extractionCount: this.extractionCount,
    });
    const mergeOptions: MergeOptions = this.config.existingDraft
      ? { existingDraft: this.config.existingDraft }
      : {};
    this.draft = mergeExtractions(
      {
        id: meta.id,
        title: this.config.title,
        sources: this.sources,
        summary: meta.summary,
      },
      batches,
      mergeOptions,
    );
    this.status = "materializing";
  }

  private async runMaterializing(): Promise<void> {
    this.status = "materializing";
    if (!this.draft)
      throw new Error("job: materializing requires a merged draft");

    const stats: ImportStats = {
      sources: this.sources?.length ?? 0,
      chapters: countChapters(this.chunks ?? []),
      chunks: this.chunks?.length ?? 0,
      extractions: this.extractionCount,
      entries: this.draft.entries.length,
      conflicts: this.draft.entries.filter(
        (e) => e.provenanceStatus === "conflict",
      ).length,
      aiInferred: this.draft.entries.filter(
        (e) => e.provenanceStatus === "ai-inferred",
      ).length,
      userEdited: this.draft.entries.filter((e) => e.userEdited === true)
        .length,
    };

    if (this.config.exportDir) {
      this.exported = await exportCovelWorldPackage(
        this.draft,
        this.config.exportDir,
      );
    }
    this.result = {
      draft: this.draft,
      stats,
      ...(this.exported ? { export: this.exported } : {}),
    };
    this.status = "completed";
  }

  private prepareChunks(): void {
    const sources: DraftSource[] = [];
    const chunks: Chunk[] = [];
    const seenSourceIds = new Set<string>();

    for (const input of this.config.inputs) {
      let sourceId = `src-${hash8(basename(input.file))}`;
      if (seenSourceIds.has(sourceId)) {
        sourceId = `src-${hash8(basename(input.file))}-${sources.length}`;
      }
      seenSourceIds.add(sourceId);

      const document = extractDocument(input.file, input.bytes);
      const source: DraftSource = {
        id: sourceId,
        file: basename(input.file),
        kind: document.kind,
        ...(document.title ? { title: document.title } : {}),
      };
      sources.push(source);
      chunks.push(
        ...chunkChapters(sourceId, document.chapters, {
          maxChars: this.config.maxChunkChars,
        }),
      );
    }
    if (chunks.length === 0) {
      throw new Error("import job: inputs produced no chunks");
    }
    this.sources = sources;
    this.chunks = chunks;
  }

  private absorbUsage(startedAt: number): void {
    const reporter = this.config.adapter as Partial<UsageReportingAdapter>;
    if (typeof reporter.getUsage === "function") {
      const usage = reporter.getUsage();
      this.usage.llmCalls = usage.llmCalls;
      this.usage.inputTokens = usage.inputTokens;
      this.usage.outputTokens = usage.outputTokens;
    }
    this.usage.durationMs = Date.now() - startedAt;
  }

  exportCheckpoint(): ImportJobCheckpoint {
    return {
      jobId: this.jobId,
      title: this.config.title,
      ...(this.config.id ? { explicitId: this.config.id } : {}),
      ...(this.config.maxChunkChars !== undefined
        ? { maxChunkChars: this.config.maxChunkChars }
        : {}),
      sources: this.sources ?? [],
      chunks: this.chunks ?? [],
      rawBatches: [...this.rawByChunk.entries()].map(([chunkId, raw]) => ({
        chunkId,
        raw,
      })),
      extractionCount: this.extractionCount,
      statusAtExport: this.status,
      ...(this.draft ? { draft: this.draft } : {}),
      usage: { ...this.usage },
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Internal: apply a checkpoint produced by exportCheckpoint(). */
  static restoreFrom(checkpoint: ImportJobCheckpoint, job: ImportJob): void {
    job.sources =
      checkpoint.sources.length > 0 ? checkpoint.sources : undefined;
    job.chunks = checkpoint.chunks.length > 0 ? checkpoint.chunks : undefined;
    job.rawByChunk.clear();
    for (const batch of checkpoint.rawBatches) {
      job.rawByChunk.set(batch.chunkId, batch.raw);
    }
    job.extractionCount = checkpoint.extractionCount;
    job.draft = checkpoint.draft;
    job.usage = { ...checkpoint.usage };
    job.error = checkpoint.error;

    const chunksKnown = job.chunks !== undefined;
    const fullyExtracted =
      chunksKnown && job.rawByChunk.size >= job.chunks!.length;
    if (checkpoint.draft && fullyExtracted) {
      job.status = "materializing";
    } else if (fullyExtracted) {
      job.status = "merging";
    } else if (chunksKnown) {
      job.status = "extracting";
    } else {
      // Nothing derivable yet — the restore must re-run from the inputs,
      // which a checkpoint without chunks cannot provide.
      throw new Error(
        "restoreImportJob: checkpoint has no chunks; it was exported before extraction started and cannot be restored without inputs",
      );
    }
  }
}

export function createImportJob(config: ImportJobConfig): ImportJob {
  if (config.inputs.length === 0) {
    throw new Error("createImportJob: at least one input is required");
  }
  return new ImportJob(config);
}

/** Run a job to completion. */
export function runImportJob(job: ImportJob): Promise<ImportJobResult> {
  return job.run();
}

/** Resume a failed/partial job from its last checkpoint (idempotent when completed). */
export function resumeImportJob(job: ImportJob): Promise<ImportJobResult> {
  return job.resume();
}

/** Current progress snapshot (status, chunks, error, usage). */
export function getImportProgress(job: ImportJob): ImportProgress {
  return job.getProgress();
}

// ── Checkpoints (no input bytes inside) ─────────────────────────

export interface ImportJobCheckpoint {
  jobId: string;
  title: string;
  explicitId?: string;
  maxChunkChars?: number;
  sources: DraftSource[];
  chunks: Chunk[];
  rawBatches: Array<{ chunkId: string; raw: RawExtraction[] }>;
  extractionCount: number;
  statusAtExport: ImportJobStatus;
  draft?: WorldImportDraft;
  usage: ImportJobUsage;
  error?: string;
}

export function exportJobCheckpoint(job: ImportJob): ImportJobCheckpoint {
  return job.exportCheckpoint();
}

export interface RestoreImportJobOptions {
  adapter: ExtractionAdapter;
  existingDraft?: WorldImportDraft;
  exportDir?: string;
}

/**
 * Rebuild a job from a checkpoint. Input bytes are NOT part of a checkpoint:
 * chunks are already derived, so extraction can resume from exactly where it
 * stopped and the inputs are never needed again.
 */
export function restoreImportJob(
  checkpoint: ImportJobCheckpoint,
  options: RestoreImportJobOptions,
): ImportJob {
  const job = new ImportJob({
    title: checkpoint.title,
    ...(checkpoint.explicitId ? { id: checkpoint.explicitId } : {}),
    inputs: [],
    adapter: options.adapter,
    ...(checkpoint.maxChunkChars !== undefined
      ? { maxChunkChars: checkpoint.maxChunkChars }
      : {}),
    ...(options.existingDraft ? { existingDraft: options.existingDraft } : {}),
    ...(options.exportDir ? { exportDir: options.exportDir } : {}),
  });
  ImportJob.restoreFrom(checkpoint, job);
  return job;
}
