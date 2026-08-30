import { request } from "./request.js";

/**
 * Client for the server-side world-import seam (/api/world-import/*):
 * multipart intake → pipeline job polling, and approve → export.
 */

export interface ImportJobView {
  id: string;
  status: "running" | "done" | "error";
  stage: "parsing" | "extracting";
  chunksDone: number;
  chunksTotal: number;
  error?: string;
  draft?: unknown;
}

export interface ExportWorldResponse {
  world: { id: string; name: string };
  worldDirName: string;
  summary: {
    files: string[];
    counts: {
      entries: number;
      sourceBacked: number;
      aiInferred: number;
      conflict: number;
      userEdited: number;
    };
  };
}

function extractErrorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // fall through to the raw body
  }
  return body.length > 0 ? body : fallback;
}

export async function startWorldImport(
  title: string,
  files: File[],
): Promise<{ jobId: string }> {
  const form = new FormData();
  form.set("title", title);
  for (const file of files) {
    form.append("files", file);
  }
  return request<{ jobId: string }>("/api/world-import/import", {
    method: "POST",
    body: form,
    silentErrors: false,
  });
}

export async function getWorldImportJob(jobId: string): Promise<ImportJobView> {
  return request<ImportJobView>(
    `/api/world-import/jobs/${encodeURIComponent(jobId)}`,
  );
}

/**
 * Approve + export. The server contract-validates the draft, enforces the
 * no-unresolved-conflicts gate, generates the Covel World Package, checks
 * it with the Covel world loader and upserts the world.
 */
export async function exportApprovedWorld(
  draft: unknown,
  resolvedConflictIds: string[],
): Promise<ExportWorldResponse> {
  try {
    return await request<ExportWorldResponse>("/api/world-import/export", {
      method: "POST",
      body: JSON.stringify({ draft, resolvedConflictIds }),
      headers: { "content-type": "application/json" },
      silentErrors: true,
    });
  } catch (error) {
    if (error instanceof Error && "status" in error && "body" in error) {
      const apiError = error as Error & { status: number; body: string };
      throw new Error(
        extractErrorMessage(
          apiError.body,
          `export failed (${apiError.status})`,
        ),
      );
    }
    throw error;
  }
}
