/**
 * World Import API — server-side seam for the review UI.
 *
 * Owns: multipart intake → @covel/world-import pipeline (async job +
 * polling), and approved-draft export → Covel World Package → loader
 * validation → world upsert. It deliberately adds no extraction logic of
 * its own; the (fake today, Provider tomorrow) adapter comes from the
 * world-import package.
 */

import path from "node:path";
import { Hono } from "hono";
import type { DataStore } from "@covel/store";
import { errorBody } from "../../../api-error.js";
import { createImportJobRunner, type ImportJob } from "./jobs.js";
import { handleExportRequest } from "./export.js";

export type WorldImportEnv = {
  Variables: {
    store: DataStore;
    worldsDirs?: readonly string[];
  };
};

/** Total upload budget across all files of one import job. */
const MAX_TOTAL_UPLOAD_BYTES = 20 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".epub"]);

export function createWorldImportRoutes(): Hono<WorldImportEnv> {
  const routes = new Hono<WorldImportEnv>();
  const runner = createImportJobRunner();

  // Intake: multipart form (title + files) → async pipeline job.
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

    const files = form
      .getAll("files")
      .filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return c.json(errorBody("at least one source file is required"), 400);
    }

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
    if (totalBytes > MAX_TOTAL_UPLOAD_BYTES) {
      return c.json(
        errorBody(`total upload size exceeds ${MAX_TOTAL_UPLOAD_BYTES} bytes`),
        400,
      );
    }

    const inputs = await Promise.all(
      files.map(async (file) => ({
        file: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );

    const job = runner.start({ title, inputs });
    return c.json({ jobId: job.id }, 201);
  });

  // Poll: job status / staged progress / result.
  routes.get("/jobs/:id", (c) => {
    const job: ImportJob | undefined = runner.get(c.req.param("id"));
    if (!job) {
      return c.json(errorBody("unknown import job id"), 404);
    }
    return c.json(job);
  });

  // Approve: validated draft → Covel World Package → loader check → upsert.
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
    const resolvedConflictIds = Array.isArray(
      (body as { resolvedConflictIds?: unknown } | null)?.resolvedConflictIds,
    )
      ? (body as { resolvedConflictIds: unknown[] }).resolvedConflictIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [];

    const outcome = await handleExportRequest({
      draft,
      resolvedConflictIds,
      targetRoot,
      upsertWorld: (record) => store.upsertWorld(record),
    });
    if (outcome.ok) {
      return c.json(outcome.value);
    }
    return c.json(errorBody(outcome.error.message), outcome.error.status);
  });

  routes.delete("/jobs", (c) => {
    runner.clearFinished();
    return c.json({ ok: true });
  });

  return routes;
}
