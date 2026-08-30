/**
 * Thin HTTP/registry wrapper over @covel/world-import's Job Core.
 *
 * All pipeline behaviour (status machine, chunk checkpoints, usage,
 * resume) lives in B's createImportJob / runImportJob / resumeImportJob /
 * getImportProgress. This module only keeps the in-process id → job map
 * the HTTP routes poll, plus the completed result (the Job Core returns
 * it from run() and does not retain it on the job object).
 */

import {
  createImportJob,
  getImportProgress,
  resumeImportJob,
  runImportJob,
  type ExtractionAdapter,
  type ImportInput,
  type ImportJob,
  type ImportJobResult,
} from "@covel/world-import";

export interface ImportJobEntry {
  readonly job: ImportJob;
  readonly title: string;
  result?: ImportJobResult;
}

const MAX_FINISHED_ENTRIES = 20;

export class WorldImportJobRegistry {
  private readonly entries = new Map<string, ImportJobEntry>();

  start(options: {
    title: string;
    inputs: ImportInput[];
    adapter: ExtractionAdapter;
  }): ImportJobEntry {
    const job = createImportJob({
      title: options.title,
      inputs: options.inputs,
      adapter: options.adapter,
    });
    const entry: ImportJobEntry = { job, title: options.title };
    this.entries.set(job.jobId, entry);
    this.gc();
    void runImportJob(job)
      .then((result) => {
        entry.result = result;
      })
      .catch(() => {
        // Failure state lives on the job itself (status + error) and is
        // surfaced through getImportProgress.
      });
    return entry;
  }

  get(jobId: string): ImportJobEntry | undefined {
    return this.entries.get(jobId);
  }

  /** Resume a failed/partial job through B's Job Core (idempotent when done). */
  async resume(jobId: string): Promise<ImportJobEntry | undefined> {
    const entry = this.entries.get(jobId);
    if (!entry) return undefined;
    const result = await resumeImportJob(entry.job).catch(() => undefined);
    if (result) entry.result = result;
    return entry;
  }

  clearFinished(): void {
    for (const [id, entry] of this.entries) {
      const status = getImportProgress(entry.job).status;
      if (status === "completed" || status === "failed") this.entries.delete(id);
    }
  }

  private gc(): void {
    const finished = [...this.entries.values()].filter((entry) => {
      const status = getImportProgress(entry.job).status;
      return status === "completed" || status === "failed";
    });
    if (finished.length <= MAX_FINISHED_ENTRIES) return;
    for (const entry of finished.slice(0, finished.length - MAX_FINISHED_ENTRIES)) {
      this.entries.delete(entry.job.jobId);
    }
  }
}
