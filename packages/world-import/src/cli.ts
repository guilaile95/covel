/**
 * CLI entry: run the full fixture pipeline without any UI.
 *
 *   pnpm --filter @covel/world-import cli -- \
 *     run --title "白霜之城" \
 *     --input tests/fixtures/白霜之城.txt \
 *     --input tests/fixtures/设定集.md \
 *     --rules tests/fixtures/fake-rules.json \
 *     --out out/白霜之城
 *
 * Steps: read inputs → extract → chunk → fake extraction → merge →
 * write <out>-draft.json → export Covel World Package → load-validate the
 * package through @covel/server's own loader (unless --no-validate).
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { FakeExtractionAdapter, type FakeRule } from "./extraction/fake.js";
import {
  applyUserEdit,
  loadDraft,
  serializeDraft,
  type UserEditPatch,
} from "./draft.js";
import { exportCovelWorldPackage } from "./export/covel-package.js";
import { runWorldImport } from "./pipeline.js";

export interface CliOptions {
  command: string;
  title: string;
  id?: string;
  inputs: string[];
  rulesFile?: string;
  draftFile?: string;
  /** Re-merge over this draft, preserving userEdited entries. */
  remergeFrom?: string;
  editsFile?: string;
  maxChars?: number;
  out: string;
  validate: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const values = new Map<string, string | string[]>();
  const push = (key: string, value: string) => {
    const existing = values.get(key);
    if (existing === undefined) values.set(key, value);
    else if (Array.isArray(existing)) existing.push(value);
    else values.set(key, [existing, value]);
  };

  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      if (command === "") command = arg;
      continue;
    }
    const key = arg.slice(2);
    if (key === "no-validate") {
      values.set("no-validate", "1");
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`cli: --${key} needs a value`);
    push(key, value);
  }

  const single = (key: string): string | undefined => {
    const v = values.get(key);
    return Array.isArray(v) ? v[0] : v;
  };
  const list = (key: string): string[] => {
    const v = values.get(key);
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
  };

  const inputs = list("input");
  if (command !== "run") {
    throw new Error(
      "cli: usage: run --title <t> --input <file> [--input ...] --out <dir>",
    );
  }
  if (inputs.length === 0)
    throw new Error("cli: at least one --input is required");
  const out = single("out");
  if (!out) throw new Error("cli: --out <dir> is required");
  const title = single("title");
  if (!title) throw new Error("cli: --title <t> is required");

  const maxCharsRaw = single("max-chars");
  return {
    command,
    title,
    id: single("id"),
    inputs,
    rulesFile: single("rules"),
    draftFile: single("draft-out"),
    remergeFrom: single("remerge-from"),
    editsFile: single("edits"),
    maxChars: maxCharsRaw ? Number(maxCharsRaw) : undefined,
    out,
    validate: values.get("no-validate") === undefined,
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply edits described in a JSON file: array of
 * `{ "id": <entryId>, "patch": { content?, name?, ... } }`.
 * Gives the review loop a file-driven way to mark userEdited entries.
 */
async function applyEditsFile(
  draftJson: string,
  editsFile: string,
): Promise<string> {
  const rawEdits = JSON.parse(await readFile(editsFile, "utf-8")) as Array<{
    id: string;
    patch: UserEditPatch;
  }>;
  let draft = loadDraft(draftJson);
  for (const edit of rawEdits) {
    draft = applyUserEdit(draft, edit.id, edit.patch);
  }
  return serializeDraft(draft);
}

export async function runCli(argv: string[]): Promise<number> {
  const options = parseCliArgs(argv);

  const rules = options.rulesFile
    ? (JSON.parse(await readFile(options.rulesFile, "utf-8")) as FakeRule[])
    : [];
  const adapter = new FakeExtractionAdapter(rules);

  const inputs = [];
  for (const file of options.inputs) {
    if (!(await fileExists(file))) {
      console.error(`cli: input not found: ${file}`);
      return 1;
    }
    inputs.push({
      file: path.basename(file),
      bytes: new Uint8Array(await readFile(file)),
    });
  }

  const existingDraft = options.remergeFrom
    ? loadDraft(await readFile(options.remergeFrom, "utf-8"))
    : undefined;

  const { draft, stats } = await runWorldImport({
    title: options.title,
    id: options.id,
    inputs,
    adapter,
    existingDraft,
    maxChunkChars: options.maxChars,
  });

  let draftJson = serializeDraft(draft);
  if (options.editsFile) {
    draftJson = await applyEditsFile(draftJson, options.editsFile);
  }

  const draftPath = options.draftFile ?? `${options.out}-draft.json`;
  await writeFile(draftPath, draftJson, "utf-8");
  const finalDraft = loadDraft(draftJson);

  const exported = await exportCovelWorldPackage(finalDraft, options.out);

  const report = {
    draft: draftPath,
    entries: finalDraft.entries.length,
    conflicts: exported.counts.conflict,
    aiInferred: exported.counts.aiInferred,
    userEdited: exported.counts.userEdited,
    package: options.out,
    files: exported.files,
  };

  if (options.validate) {
    const { loadSingleWorld } =
      await import("@covel/server/src/world-seed-loader.js");
    const record = await loadSingleWorld(options.out);
    if (record === null) {
      console.error(JSON.stringify({ ...report, validated: false }));
      console.error(
        "cli: generated world package failed Covel load validation",
      );
      return 2;
    }
    console.log(
      JSON.stringify({ ...report, validated: true, worldId: record.id }),
    );
    return 0;
  }

  console.log(JSON.stringify({ ...report, validated: false }));
  return 0;
}

async function main(): Promise<number> {
  try {
    return await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `cli: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

// tsx src/cli.ts run ...
if (
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("src/cli.ts")
) {
  main().then((code) => {
    process.exitCode = code;
  });
}
