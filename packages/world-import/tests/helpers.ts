import {
  runWorldImport,
  type ImportInput,
  type WorldImportResult,
} from "../src/pipeline.js";
import { FakeExtractionAdapter } from "../src/extraction/fake.js";
import type { DraftEntry, WorldImportDraft } from "../src/types.js";
import {
  buildFixtureEpub,
  FIXTURE_RULES,
  NOVEL_TXT,
  SETTING_MD,
} from "./fixtures.js";

export const TITLE = "白霜之城";

export const FIXTURE_INPUTS: ImportInput[] = [
  { file: "白霜之城.txt", bytes: new TextEncoder().encode(NOVEL_TXT) },
  { file: "设定集.md", bytes: new TextEncoder().encode(SETTING_MD) },
  { file: "雾塔行记.epub", bytes: buildFixtureEpub() },
];

export function runFixturePipeline(options: {
  maxChunkChars?: number;
  existingDraft?: WorldImportDraft;
}): Promise<WorldImportResult> {
  return runWorldImport({
    title: TITLE,
    inputs: FIXTURE_INPUTS,
    adapter: new FakeExtractionAdapter(FIXTURE_RULES),
    existingDraft: options.existingDraft,
    maxChunkChars: options.maxChunkChars,
  });
}

export function findEntry(draft: WorldImportDraft, name: string): DraftEntry {
  const entry = draft.entries.find((e) => e.name === name);
  if (!entry) throw new Error(`entry not found: ${name}`);
  return entry;
}
