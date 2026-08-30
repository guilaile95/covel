import type { WorldImportDraft } from "./model.js";

/**
 * Export helpers for the approved draft. The draft content itself always
 * travels as contract JSON; the browser download is just a convenience
 * wrapper around `JSON.stringify`.
 */

export function buildExportPayload(draft: WorldImportDraft): string {
  return JSON.stringify(draft, null, 2);
}

export function exportFileName(draft: WorldImportDraft): string {
  return `world-import-draft-${draft.id}.json`;
}

/** Trigger a browser download of the current draft. */
export function downloadWorldImportDraft(draft: WorldImportDraft): void {
  const blob = new Blob([buildExportPayload(draft)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exportFileName(draft);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
