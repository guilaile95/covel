/**
 * Merge raw extractions into a WorldImportDraft.
 *
 * Rules (v1):
 *  - stable ids: derived from (type, canonical name), deterministic;
 *  - alias merge: entities sharing any normalized name/alias within the same
 *    type are one entity (exact match only, no fuzzy matching);
 *  - cross-chunk merge: contributions from later chunks append content and
 *    provenance, never overwrite;
 *  - conflicts: two different claim values for the same (entity, field)
 *    mark the entry "conflict" — merge never picks a winner;
 *  - "ai-inferred": entries whose every contribution lacked source
 *    paragraphs stay ai-inferred; inferred lines merged into a
 *    source-backed entry keep an explicit [推断] prefix;
 *  - userEdited entries from an existing draft are kept verbatim; incoming
 *    extractions matching them are skipped instead of overwriting;
 *  - conflictResolved entries keep their old conflict suppressed on re-merge
 *    (fingerprint match against the resolved notes), but a GENUINELY NEW
 *    claim conflict re-opens the entry: provenanceStatus=conflict and the
 *    resolved flag is cleared;
 *  - decided (aiAccepted / conflictResolved) entries keep their previous
 *    content and sourceRefs even in rounds that extract nothing for them;
 *  - aiAccepted / conflictResolved / userEdited flags survive re-merge;
 *  - source-backed refs carry a short verbatim quote (truncated).
 */

import type {
  Chunk,
  DraftEntry,
  DraftSource,
  ProvenanceStatus,
  RawExtraction,
  SourceRef,
  WorldImportDraft,
} from "./types.js";
import { DRAFT_VERSION } from "./types.js";
import { entryId, formatLocator, normalizeName } from "./util.js";

export interface ExtractionBatch {
  chunk: Chunk;
  raw: RawExtraction[];
}

export interface MergeInput {
  id: string;
  title: string;
  sources: DraftSource[];
  summary: string;
}

interface Contribution {
  text: string;
  status: "source-backed" | "ai-inferred";
  ref?: SourceRef;
}

interface ClaimState {
  value: string;
  refs: string[];
}

/** One detected claim conflict, with a stable fingerprint for identity. */
interface ConflictLine {
  /** `field|sorted(values)` — matches against fingerprints resolved earlier. */
  fingerprint: string;
  text: string;
}

interface InternalEntry extends DraftEntry {
  contributions: Contribution[];
  claims: Map<string, ClaimState>;
  conflictLines: ConflictLine[];
  keys: Set<string>;
  /**
   * Carried-over state of a decided (aiAccepted / conflictResolved) entry
   * seeded from an existing draft: its previous content and sourceRefs stay
   * intact even when this merge round extracts nothing for the entity.
   */
  seeded?: { content: string; sourceRefs: SourceRef[] };
}

/** Maximum characters of verbatim quote kept per sourceRef. */
const QUOTE_MAX_CHARS = 160;

export interface MergeOptions {
  /** Previously built draft; entries with userEdited=true are preserved verbatim. */
  existingDraft?: WorldImportDraft;
}

export function mergeExtractions(
  input: MergeInput,
  batches: ExtractionBatch[],
  options: MergeOptions = {},
): WorldImportDraft {
  const entries = new Map<string, InternalEntry>();
  const keyIndex = new Map<string, string>();

  const registerKeys = (entry: InternalEntry) => {
    for (const key of entry.keys) keyIndex.set(key, entry.id);
  };

  const keysOf = (
    type: string,
    name: string,
    aliases: string[],
  ): Set<string> => {
    const keys = new Set<string>();
    for (const candidate of [name, ...aliases]) {
      const normalized = normalizeName(candidate);
      if (normalized.length > 0) keys.add(`${type}|${normalized}`);
    }
    return keys;
  };

  // Seed entries that carry user decisions so their flags survive re-merge:
  //  - userEdited → fully frozen (incoming extractions are dropped);
  //  - conflictResolved / aiAccepted → keep merging; previous content and
  //    sourceRefs ride along so a round without new evidence cannot wipe them.
  if (options.existingDraft) {
    for (const entry of options.existingDraft.entries) {
      const frozen = entry.userEdited === true;
      const decided =
        entry.conflictResolved === true || entry.aiAccepted === true;
      if (!frozen && !decided) continue;
      const seeded: InternalEntry = {
        ...entry,
        contributions: [],
        claims: new Map(),
        conflictLines: [],
        keys: keysOf(entry.type, entry.name, entry.aliases),
        seeded: { content: entry.content, sourceRefs: entry.sourceRefs },
      };
      entries.set(entry.id, seeded);
      registerKeys(seeded);
    }
  }

  const findTarget = (
    type: string,
    name: string,
    aliases: string[],
  ): InternalEntry | null => {
    for (const candidate of [name, ...aliases]) {
      const normalized = normalizeName(candidate);
      if (normalized.length === 0) continue;
      const existingId = keyIndex.get(`${type}|${normalized}`);
      if (existingId) return entries.get(existingId) ?? null;
    }
    return null;
  };

  for (const batch of batches) {
    for (const raw of batch.raw) {
      const aliases = raw.aliases ?? [];
      const existing = findTarget(raw.type, raw.name, aliases);
      const target: InternalEntry =
        existing ??
        ({
          id: entryId(raw.type, raw.name),
          type: raw.type,
          name: raw.name,
          aliases: [],
          content: "",
          provenanceStatus: "ai-inferred",
          sourceRefs: [],
          contributions: [],
          claims: new Map(),
          conflictLines: [],
          keys: keysOf(raw.type, raw.name, aliases),
        } as InternalEntry);

      if (!existing) {
        entries.set(target.id, target);
        registerKeys(target);
      }
      if (existing !== null && existing.userEdited === true) {
        // Never overwrite a user edit; drop the incoming extraction.
        continue;
      }

      const ref: SourceRef | undefined =
        raw.status === "source-backed"
          ? {
              sourceId: batch.chunk.sourceId,
              locator: locatorFor(raw.paragraphs, batch.chunk),
              ...quoteFor(raw.paragraphs, batch.chunk),
            }
          : undefined;

      target.contributions.push({ text: raw.content, status: raw.status, ref });

      for (const claim of raw.claims ?? []) {
        const field = claim.field.trim();
        const value = claim.value.trim();
        if (field.length === 0 || value.length === 0) continue;
        const state = target.claims.get(field);
        if (!state) {
          target.claims.set(field, {
            value,
            refs: ref ? [describeRef(ref)] : ["（无来源）"],
          });
          continue;
        }
        if (state.value !== value) {
          // Conflicts are recorded even on resolved entries — finalize()
          // decides which ones are re-openings of a resolved conflict and
          // which ones are genuinely new.
          const text = `字段「${field}」冲突：${state.value}（${state.refs.join("、")}）vs ${value}（${ref ? describeRef(ref) : "无来源"}）`;
          target.conflictLines.push({
            fingerprint: conflictFingerprint(field, state.value, value),
            text,
          });
        }
      }

      // New aliases extend the entity but never remove old ones.
      for (const key of keysOf(raw.type, raw.name, aliases)) {
        target.keys.add(key);
        keyIndex.set(key, target.id);
        const alias = [raw.name, ...aliases].find(
          (a) => `${raw.type}|${normalizeName(a)}` === key,
        );
        if (alias && alias !== target.name && !target.aliases.includes(alias)) {
          target.aliases.push(alias);
        }
      }
    }
  }

  const draftEntries: DraftEntry[] = [...entries.values()].map((entry) =>
    entry.userEdited === true ? stripInternal(entry) : finalizeEntry(entry),
  );

  return {
    version: DRAFT_VERSION,
    id: input.id,
    title: input.title,
    sources: input.sources,
    summary: input.summary,
    entries: draftEntries,
  };
}

function locatorFor(paragraphs: number[] | undefined, chunk: Chunk): string {
  if (!paragraphs || paragraphs.length === 0) {
    return formatLocator(
      chunk.chapterIndex,
      chunk.startParagraph,
      chunk.endParagraph,
    );
  }
  const absolute = paragraphs.map((p) => chunk.startParagraph + p - 1);
  return formatLocator(
    chunk.chapterIndex,
    Math.min(...absolute),
    Math.max(...absolute),
  );
}

function quoteFor(
  paragraphs: number[] | undefined,
  chunk: Chunk,
): { quote: string } | {} {
  const chunkParagraphs = chunk.text.split("\n");
  const first =
    paragraphs && paragraphs.length > 0
      ? chunkParagraphs[paragraphs[0] - 1]
      : chunkParagraphs[0];
  if (first === undefined) return {};
  const quote = first.trim().slice(0, QUOTE_MAX_CHARS);
  return quote.length > 0 ? { quote } : {};
}

function describeRef(ref: SourceRef): string {
  return `${ref.sourceId} ${ref.locator}`;
}

const INFERRED_PREFIX = "[推断] ";

/** Stable identity of a conflict pair: field + sorted values, no locators. */
function conflictFingerprint(field: string, a: string, b: string): string {
  return `${field}|${[a, b].sort().join("◆")}`;
}

/**
 * Recover which conflicts a user already resolved, from the entry's old
 * conflictNotes. This is the thinnest possible fingerprint mechanism: the
 * notes text is the only place the contract keeps the resolved pairs.
 * `字段「age」冲突：16（refs）vs 19（refs）` → `age|16◆19`.
 */
function parseResolvedFingerprints(notes: string): Set<string> {
  const fingerprints = new Set<string>();
  if (notes.length === 0) return fingerprints;
  for (const segment of notes.split("；")) {
    const match = segment.match(/字段「([^」]+)」冲突：(.+)vs(.+)/);
    if (!match) continue;
    const field = match[1].trim();
    const left = stripRefSide(match[2]);
    const right = stripRefSide(match[3]);
    if (left.length > 0 && right.length > 0) {
      fingerprints.add(conflictFingerprint(field, left, right));
    }
  }
  return fingerprints;
}

/** Strip the trailing `（refs…）` provenance suffix from a conflict side. */
function stripRefSide(side: string): string {
  const idx = side.indexOf("（");
  return (idx === -1 ? side : side.slice(0, idx)).trim();
}

function finalizeEntry(entry: InternalEntry): DraftEntry {
  // Decided entries keep their previous content/sourceRefs even when this
  // round produced no new extraction for the entity.
  const seeded = entry.seeded;
  const contents: string[] = [];
  const seen = new Set<string>();
  let hasSource = (seeded?.sourceRefs.length ?? 0) > 0;

  if (seeded && seeded.content.length > 0) {
    contents.push(seeded.content);
    seen.add(seeded.content);
  }
  for (const contribution of entry.contributions) {
    if (contribution.status === "source-backed") hasSource = true;
    const text =
      contribution.status === "ai-inferred" && hasSource
        ? INFERRED_PREFIX + contribution.text
        : contribution.text;
    if (!seen.has(text)) {
      seen.add(text);
      contents.push(text);
    }
  }

  // Split this round's conflicts into "the resolved ones came back" (fine)
  // and "genuinely new conflicts" (re-open the entry).
  const resolvedFingerprints =
    entry.conflictResolved === true
      ? parseResolvedFingerprints(entry.conflictNotes ?? "")
      : new Set<string>();
  const newConflicts = entry.conflictLines.filter(
    (line) => !resolvedFingerprints.has(line.fingerprint),
  );
  const staysResolved =
    entry.conflictResolved === true && newConflicts.length === 0;

  let provenanceStatus: ProvenanceStatus = "ai-inferred";
  if (newConflicts.length > 0) provenanceStatus = "conflict";
  else if (hasSource) provenanceStatus = "source-backed";

  const sourceRefs = [
    ...(seeded?.sourceRefs ?? []),
    ...entry.contributions
      .map((c) => c.ref)
      .filter((ref): ref is SourceRef => ref !== undefined),
  ].filter(
    (ref, i, all) =>
      all.findIndex(
        (r) =>
          r.sourceId === ref.sourceId &&
          r.locator === ref.locator &&
          r.quote === ref.quote,
      ) === i,
  );

  const result: DraftEntry = {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    aliases: [...entry.aliases],
    content: contents.join("\n\n"),
    provenanceStatus,
    sourceRefs,
  };

  if (newConflicts.length > 0) {
    result.conflictNotes = newConflicts.map((c) => c.text).join("；");
  }
  if (entry.aiAccepted === true) result.aiAccepted = true;
  if (staysResolved) result.conflictResolved = true;
  return result;
}

/** Keep a userEdited entry exactly as the user left it. */
function stripInternal(entry: InternalEntry): DraftEntry {
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name,
    aliases: [...entry.aliases],
    content: entry.content,
    provenanceStatus: entry.provenanceStatus,
    sourceRefs: entry.sourceRefs.map((ref) => ({ ...ref })),
    conflictNotes: entry.conflictNotes,
    userEdited: true,
    aiAccepted: entry.aiAccepted,
    conflictResolved: entry.conflictResolved,
  };
}
