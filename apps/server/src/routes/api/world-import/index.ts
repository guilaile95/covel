/**
 * World Import API — thin HTTP surface over @covel/world-import.
 *
 * - POST /import  → multipart intake → B's Job Core (createImportJob +
 *   runImportJob). Production adapter: B's LlmExtractionAdapter bound to
 *   the server's canonical LLMAdapter (existing model config; the model
 *   field is a Covel slot name).
 * - GET /jobs/:id → getImportProgress + the completed result.
 * - POST /jobs/:id/resume → resumeImportJob (continue from checkpoint).
 * - POST /export  → canonical-draft approval gate → exportCovelWorldPackage
 *   → Covel world loader → store upsert.
 *
 * This module adds no extraction, merge, job-status or export logic of its
 * own; it only adapts HTTP to the package and keeps the id → job registry.
 */

import path from "node:path";
import { Hono } from "hono";
import {
  getImportProgress,
  type ExtractionAdapter,
  type ImportInput,
  type ImportJobResult,
} from "@covel/world-import";
import type { LLMAdapter } from "@covel/runtime";
import type { DataStore } from "@covel/store";
import { errorBody } from "../../../api-error.js";
import {
  WorldImportJobRegistry,
  type ImportJobEntry,
} from "./jobs.js";
import { createLlmExtractionAdapter } from "./adapter.js";
import { handleExportRequest } from "./export.js";

export type WorldImportEnv = {
  Variables: {
    store: DataStore;
    llmAdapter?: LLMAdapter;
    worldsDirs?: readonly string[];
  };
};

export interface WorldImportRouteOptions {
  /**
   * Production: omitted → B's LlmExtractionAdapter on the server's
   * llmAdapter (Covel gateway/model config). Tests inject a fake-backend
   * adapter here; the fake never reaches a production route.
   */
  buildAdapter?: (options: { presetId?: string }) => ExtractionAdapter;
  /** Hard upload budget across all files of one import job. */
  maxTotalUploadBytes?: number;
}

const DEFAULT_MAX_TOTAL_UPLOAD_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".epub"]);

export function createWorldImportRoutes(
  options: WorldImportRouteOptions = {},
): Hono<WorldImportEnv> {
  const routes = new Hono<WorldImportEnv>();
  const registry = new WorldImportJobRegistry();

  // Intake: multipart form (title + files[+ model slot]) → async job.
  routes.post("/import", async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json(
        errorBody("expected multipart/form-data with title and files"),
        400,
      );
    }

    const title = (form.get("title") ?? "").toString().trim();
    if (title.length === 0) {
      return c.json(errorBody("title is required"), 400);
    }
    const presetIdRaw = form.get("model");
    const presetId =
      typeof presetIdRaw === "string" && presetIdRaw.trim().length > 0
        ? presetIdRaw.trim()
        : undefined;

    const files = form
      .getAll("files")
      .filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return c.json(errorBody("at least one source file is required"), 400);
    }

    const maxTotal =
      options.maxTotalUploadBytes ?? DEFAULT_MAX_TOTAL_UPLOAD_BYTES;
    let totalBytes = 0;
    for (const file of files) {
      const extension = path.extname(file.name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        return c.json(
          errorBody(
            `unsupported file type: ${file.name} (${extension || "none"})`,
          ),
          400,
        );
      }
      totalBytes += file.size;
    }
    if (totalBytes > maxTotal) {
      return c.json(
        errorBody(`total upload size exceeds ${maxTotal} bytes`),
        400,
      );
    }

    const inputs: ImportInput[] = await Promise.all(
      files.map(async (file) => ({
        file: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );

    const adapter =
      options.buildAdapter?.({ presetId }) ??
      buildProductionAdapter(c, presetId);

    const entry = registry.start({ title, inputs, adapter });
    return c.json({ jobId: entry.job.jobId }, 201);
  });

  // Poll: B's progress snapshot + the completed draft/stats.
  routes.get("/jobs/:id", (c) => {
    const entry = registry.get(c.req.param("id"));
    if (!entry) {
      return c.json(errorBody("unknown import job id"), 404);
    }
    return c.json(serializeEntry(entry));
  });

  // Resume a failed/partial job from its checkpoint.
  routes.post("/jobs/:id/resume", async (c) => {
    const entry = await registry.resume(c.req.param("id"));
    if (!entry) {
      return c.json(errorBody("unknown import job id"), 404);
    }
    return c.json(serializeEntry(entry));
  });

  routes.delete("/jobs", (c) => {
    registry.clearFinished();
    return c.json({ ok: true });
  });

  // Approve: canonical draft → Covel World Package → loader → upsert.
  routes.post("/export", async (c) => {
    const store = c.get("store");
    const worldsDirs = c.get("worldsDirs");
    if (!worldsDirs || worldsDirs.length === 0) {
      return c.json(
        errorBody("no worlds directory is configured on this server"),
        500,
      );
    }
    // mergeDirs(bundled, user) puts the user dir last when configured —
    // generated worlds belong there, not inside the bundled set.
    const targetRoot = worldsDirs[worldsDirs.length - 1];

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(errorBody("expected a JSON body"), 400);
    }
    const draft = (body as { draft?: unknown } | null)?.draft;

    const outcome = await handleExportRequest({
      draft,
      targetRoot,
      upsertWorld: (record) => store.upsertWorld(record),
    });
    if (outcome.ok) {
      return c.json(outcome.value);
    }
    return c.json(errorBody(outcome.error.message), outcome.error.status);
  });

  return routes;
}

function buildProductionAdapter(
  c: { get: (key: "llmAdapter") => LLMAdapter | undefined },
  presetId?: string,
): ExtractionAdapter {
  const llm = c.get("llmAdapter");
  if (!llm) {
    throw new Error(
      "no LLM adapter configured on this server — cannot run extraction",
    );
  }
  return createLlmExtractionAdapter(llm, presetId);
}

function serializeEntry(entry: ImportJobEntry) {
  const progress = getImportProgress(entry.job);
  const result: ImportJobResult | undefined = entry.result;
  return {
    jobId: progress.jobId,
    title: entry.title,
    status: progress.status,
    stage: progress.status,
    processedChunks: progress.processedChunks,
    chunksTotal: progress.totalChunks,
    error: progress.error,
    usage: progress.usage,
    ...(result
      ? {
          draft: result.draft,
          stats: result.stats,
        }
      : {}),
  };
}
