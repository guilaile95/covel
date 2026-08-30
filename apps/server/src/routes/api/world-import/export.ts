/**
 * Approve-side handler: draft → Covel World Package → loader validation →
 * world upsert. Errors are reported verbatim to the UI — a failed loader
 * check must surface as a failure, never as a fake success.
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import {
  exportCovelWorldPackage,
  loadDraft,
  DraftContractError,
  type ExportedPackageSummary,
  type WorldImportDraft,
} from "@covel/world-import";
import { loadSingleWorld } from "../../../world-seed-loader.js";
import type { WorldRecord } from "@covel/store";

export type ExportOutcome =
  | {
      ok: true;
      value: {
        world: Pick<WorldRecord, "id" | "name">;
        worldDirName: string;
        summary: ExportedPackageSummary;
      };
    }
  | { ok: false; error: { status: 400 | 409 | 422 | 500; message: string } };

export async function handleExportRequest(options: {
  draft: unknown;
  resolvedConflictIds: string[];
  targetRoot: string;
  upsertWorld: (record: WorldRecord) => Promise<void>;
}): Promise<ExportOutcome> {
  // 1) Contract validation through the shared package — the UI may never
  //    push a non-conformant draft past review.
  let draft: WorldImportDraft;
  try {
    draft = loadDraft(JSON.stringify(options.draft));
  } catch (error) {
    const message =
      error instanceof DraftContractError
        ? error.message
        : "draft failed contract validation";
    return { ok: false, error: { status: 400, message } };
  }

  // 2) Approval gate: every conflict entry must be marked resolved by the
  //    review UI (decision state is client-owned, passed explicitly).
  const unresolved = draft.entries.filter(
    (entry) =>
      entry.provenanceStatus === "conflict" &&
      !options.resolvedConflictIds.includes(entry.id),
  );
  if (unresolved.length > 0) {
    return {
      ok: false,
      error: {
        status: 409,
        message: `cannot approve: ${unresolved.length} unresolved conflict entr(y/ies): ${unresolved.map((e) => e.name).join(", ")}`,
      },
    };
  }

  // 3) Generate the package. `imported-` marks generated worlds so they are
  //    easy to spot and clean up next to hand-written world packages.
  const worldDir = path.join(options.targetRoot, `imported-${draft.id}`);
  await rm(worldDir, { recursive: true, force: true });
  let summary: ExportedPackageSummary;
  try {
    summary = await exportCovelWorldPackage(draft, worldDir);
  } catch (error) {
    return {
      ok: false,
      error: {
        status: 422,
        message: `package generation failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  // 4) Covel's own loader decides whether the package is a world.
  let record: WorldRecord | null = null;
  try {
    record = await loadSingleWorld(worldDir);
  } catch (error) {
    return {
      ok: false,
      error: {
        status: 422,
        message: `world loader threw: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
  if (!record) {
    return {
      ok: false,
      error: {
        status: 422,
        message:
          "Covel world loader rejected the generated package (see server log for validation details)",
      },
    };
  }

  // 5) Upsert so the world appears in the existing world list immediately.
  try {
    await options.upsertWorld(record);
  } catch (error) {
    return {
      ok: false,
      error: {
        status: 500,
        message: `world upsert failed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }

  return {
    ok: true,
    value: {
      world: { id: record.id, name: record.name },
      worldDirName: path.basename(worldDir),
      summary,
    },
  };
}
