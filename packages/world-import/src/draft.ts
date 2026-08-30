/**
 * WorldImportDraft serialization, contract validation and user edits.
 *
 * The v0 contract is frozen; loadDraft rejects anything that does not match
 * it so downstream consumers (A: Prompt Play, C: review UI) can rely on the
 * shape. applyUserEdit never silently rewrites anything else — it replaces
 * exactly one entry and stamps userEdited=true, which merge and export
 * preserve.
 */

import {
  DRAFT_VERSION,
  ENTRY_TYPES,
  PROVENANCE_STATUSES,
  type DraftEntry,
  type EntryType,
  type ProvenanceStatus,
  type SourceKind,
  type WorldImportDraft,
} from "./types.js";

const SOURCE_KINDS: SourceKind[] = ["txt", "md", "epub"];

export function serializeDraft(draft: WorldImportDraft): string {
  return `${JSON.stringify(draft, null, 2)}\n`;
}

export class DraftContractError extends Error {}

/**
 * Canonical v0 key sets. Unknown keys anywhere inside draft / source /
 * entry / sourceRef are rejected (v0 is strict — no extension bag, no
 * silent field drops).
 */
const DRAFT_KEYS: ReadonlySet<string> = new Set([
  "version",
  "id",
  "title",
  "sources",
  "summary",
  "entries",
]);
const SOURCE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "file",
  "kind",
  "title",
]);
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  "id",
  "type",
  "name",
  "aliases",
  "content",
  "provenanceStatus",
  "sourceRefs",
  "conflictNotes",
  "userEdited",
  "aiAccepted",
  "conflictResolved",
]);
const SOURCE_REF_KEYS: ReadonlySet<string> = new Set([
  "sourceId",
  "locator",
  "quote",
]);

function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  what: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new DraftContractError(
        `${what}: unknown contract field "${key}" (v0 allows only: ${[...allowed].join(", ")})`,
      );
    }
  }
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DraftContractError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string")
    throw new DraftContractError(`${what} must be a string`);
  return value;
}

function requireStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new DraftContractError(`${what} must be an array of strings`);
  }
  return value as string[];
}

function parseEntryType(value: string, what: string): EntryType {
  if (!(ENTRY_TYPES as readonly string[]).includes(value)) {
    throw new DraftContractError(`${what}: unknown entry type "${value}"`);
  }
  return value as EntryType;
}

function parseProvenanceStatus(value: string, what: string): ProvenanceStatus {
  if (!(PROVENANCE_STATUSES as readonly string[]).includes(value)) {
    throw new DraftContractError(
      `${what}: unknown provenanceStatus "${value}"`,
    );
  }
  return value as ProvenanceStatus;
}

function parseEntry(value: unknown, index: number): DraftEntry {
  const what = `entries[${index}]`;
  const raw = requireObject(value, what);
  rejectUnknownKeys(raw, ENTRY_KEYS, what);
  const entry: DraftEntry = {
    id: requireString(raw.id, `${what}.id`),
    type: parseEntryType(requireString(raw.type, `${what}.type`), what),
    name: requireString(raw.name, `${what}.name`),
    aliases: requireStringArray(raw.aliases ?? [], `${what}.aliases`),
    content: requireString(raw.content, `${what}.content`),
    provenanceStatus: parseProvenanceStatus(
      requireString(raw.provenanceStatus, `${what}.provenanceStatus`),
      what,
    ),
    sourceRefs: requireStringArrayKeyed(
      raw.sourceRefs ?? [],
      what,
      "sourceRefs",
    ),
  };
  if (raw.conflictNotes !== undefined) {
    entry.conflictNotes = requireString(
      raw.conflictNotes,
      `${what}.conflictNotes`,
    );
  }
  for (const flag of [
    "userEdited",
    "aiAccepted",
    "conflictResolved",
  ] as const) {
    if (raw[flag] !== undefined) {
      if (typeof raw[flag] !== "boolean") {
        throw new DraftContractError(`${what}.${flag} must be a boolean`);
      }
      entry[flag] = raw[flag];
    }
  }
  return entry;
}

function requireStringArrayKeyed(
  value: unknown,
  what: string,
  field: "sourceRefs",
): Array<{ sourceId: string; locator: string; quote?: string }> {
  if (!Array.isArray(value)) {
    throw new DraftContractError(`${what}.${field} must be an array`);
  }
  return value.map((item, i) => {
    const ref = requireObject(item, `${what}.${field}[${i}]`);
    rejectUnknownKeys(ref, SOURCE_REF_KEYS, `${what}.${field}[${i}]`);
    return {
      sourceId: requireString(ref.sourceId, `${what}.${field}[${i}].sourceId`),
      locator: requireString(ref.locator, `${what}.${field}[${i}].locator`),
      quote:
        ref.quote === undefined
          ? undefined
          : requireString(ref.quote, `${what}.${field}[${i}].quote`),
    };
  });
}

/** Parse and validate a serialized draft against the frozen v0 contract. */
export function loadDraft(json: string): WorldImportDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new DraftContractError(`invalid JSON: ${String(error)}`);
  }
  const raw = requireObject(parsed, "draft");
  rejectUnknownKeys(raw, DRAFT_KEYS, "draft");

  const version = raw.version;
  if (version !== DRAFT_VERSION) {
    throw new DraftContractError(
      `unsupported draft version ${String(version)} (expected ${DRAFT_VERSION})`,
    );
  }

  const sourcesRaw = requireArray(raw.sources, "sources").map((item, i) => {
    const source = requireObject(item, `sources[${i}]`);
    rejectUnknownKeys(source, SOURCE_KEYS, `sources[${i}]`);
    const kindRaw = requireString(source.kind, `sources[${i}].kind`);
    if (!(SOURCE_KINDS as string[]).includes(kindRaw)) {
      throw new DraftContractError(
        `sources[${i}].kind: unknown source kind "${kindRaw}"`,
      );
    }
    const kind = kindRaw as SourceKind;
    return {
      id: requireString(source.id, `sources[${i}].id`),
      file: requireString(source.file, `sources[${i}].file`),
      kind,
      title:
        source.title === undefined
          ? undefined
          : requireString(source.title, `sources[${i}].title`),
    };
  });

  return {
    version: DRAFT_VERSION,
    id: requireString(raw.id, "id"),
    title: requireString(raw.title, "title"),
    sources: sourcesRaw,
    summary: requireString(raw.summary, "summary"),
    entries: requireArray(raw.entries, "entries").map(parseEntry),
  };
}

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value))
    throw new DraftContractError(`${what} must be an array`);
  return value;
}

/** Fields a user may edit on an entry. */
export type UserEditPatch = Partial<
  Pick<
    DraftEntry,
    | "name"
    | "aliases"
    | "content"
    | "provenanceStatus"
    | "conflictNotes"
    | "userEdited"
    | "aiAccepted"
    | "conflictResolved"
  >
>;

/**
 * Apply a manual edit to one entry. Returns a NEW draft; the target entry is
 * replaced with the patch and stamped userEdited=true. Later merges keep it
 * verbatim and export never overwrites it.
 */
export function applyUserEdit(
  draft: WorldImportDraft,
  entryIdToEdit: string,
  patch: UserEditPatch,
): WorldImportDraft {
  let found = false;
  const entries = draft.entries.map((entry) => {
    if (entry.id !== entryIdToEdit) return entry;
    found = true;
    return {
      ...entry,
      ...patch,
      userEdited: true,
    };
  });
  if (!found) {
    throw new Error(`applyUserEdit: no entry with id "${entryIdToEdit}"`);
  }
  return { ...draft, entries };
}

/**
 * Record the user's decision flags on one entry WITHOUT marking it
 * userEdited: accepting an AI inference or resolving a conflict does not
 * necessarily change the content. Returns a NEW draft.
 */
export function setUserDecision(
  draft: WorldImportDraft,
  entryIdToEdit: string,
  decision: Pick<UserEditPatch, "aiAccepted" | "conflictResolved">,
): WorldImportDraft {
  let found = false;
  const entries = draft.entries.map((entry) => {
    if (entry.id !== entryIdToEdit) return entry;
    found = true;
    return { ...entry, ...decision };
  });
  if (!found) {
    throw new Error(`setUserDecision: no entry with id "${entryIdToEdit}"`);
  }
  return { ...draft, entries };
}

export function markAiAccepted(
  draft: WorldImportDraft,
  entryIdToEdit: string,
): WorldImportDraft {
  return setUserDecision(draft, entryIdToEdit, { aiAccepted: true });
}

export function markConflictResolved(
  draft: WorldImportDraft,
  entryIdToEdit: string,
): WorldImportDraft {
  return setUserDecision(draft, entryIdToEdit, { conflictResolved: true });
}
