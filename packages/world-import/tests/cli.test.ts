import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.js";
import { entryId } from "../src/util.js";
import { FIXTURE_INPUTS } from "./helpers.js";
import { FIXTURE_RULES } from "./fixtures.js";

let dir: string;
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "covel-cli-"));
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function writeFixtureFiles(): Promise<string[]> {
  const paths: string[] = [];
  for (const input of FIXTURE_INPUTS) {
    const filePath = path.join(dir, input.file);
    await writeFile(filePath, input.bytes);
    paths.push(filePath);
  }
  await writeFile(
    path.join(dir, "rules.json"),
    JSON.stringify(FIXTURE_RULES, null, 2),
    "utf-8",
  );
  return paths;
}

function baseArgs(files: string[], out: string): string[] {
  return [
    "run",
    "--title",
    "白霜之城",
    "--rules",
    path.join(dir, "rules.json"),
    "--out",
    out,
    ...files.flatMap((f) => ["--input", f]),
  ];
}

describe("runCli", () => {
  it("runs the full fixture pipeline and validates the package via Covel's loader", async () => {
    const files = await writeFixtureFiles();
    const out = path.join(dir, "world");
    const code = await runCli(baseArgs(files, out));

    expect(code).toBe(0);
    for (const file of [
      "world.yaml",
      "WORLD.md",
      "data/dimensions.yaml",
      "data/lorebook.yaml",
    ]) {
      await expect(readFile(path.join(out, file), "utf-8")).resolves.toContain(
        "白霜",
      );
    }
    await expect(
      readFile(path.join(out, "data/world.data.yaml"), "utf-8"),
    ).resolves.toContain("world:metadata.dimensions");
    expect(logs.join("\n")).toContain('"validated":true');
  }, 30000);

  it("is deterministic across CLI runs", async () => {
    const files = await writeFixtureFiles();
    const out = path.join(dir, "world");
    await runCli(baseArgs(files, out));
    const draft1 = await readFile(`${out}-draft.json`, "utf-8");
    const manifest1 = await readFile(path.join(out, "world.yaml"), "utf-8");

    await runCli(baseArgs(files, out));
    const draft2 = await readFile(`${out}-draft.json`, "utf-8");
    const manifest2 = await readFile(path.join(out, "world.yaml"), "utf-8");

    expect(draft1).toBe(draft2);
    expect(manifest1).toBe(manifest2);
  }, 30000);

  it("supports file-driven edits plus re-merge, preserving userEdited entries", async () => {
    const files = await writeFixtureFiles();
    const out = path.join(dir, "world");
    await runCli(baseArgs(files, out));

    const shenDuoId = entryId("character", "沈铎");
    const editsPath = path.join(dir, "edits.json");
    await writeFile(
      editsPath,
      JSON.stringify([
        { id: shenDuoId, patch: { content: "人工定稿：沈铎是北岭的守塔人。" } },
      ]),
      "utf-8",
    );

    const draft1 = await readFile(`${out}-draft.json`, "utf-8");
    const draft2Path = path.join(dir, "draft-after.json");
    const code = await runCli([
      ...baseArgs(files, out),
      "--remerge-from",
      `${out}-draft.json`,
      "--edits",
      editsPath,
      "--draft-out",
      draft2Path,
    ]);

    expect(code).toBe(0);
    const draft2 = JSON.parse(await readFile(draft2Path, "utf-8"));
    const shenDuo = draft2.entries.find(
      (e: { id: string }) => e.id === shenDuoId,
    );
    expect(shenDuo.userEdited).toBe(true);
    expect(shenDuo.content).toBe("人工定稿：沈铎是北岭的守塔人。");
    // draft 1 must not have been touched by the edits
    expect(
      JSON.parse(draft1).entries.find((e: { id: string }) => e.id === shenDuoId)
        .userEdited,
    ).toBeUndefined();
  }, 30000);

  it("rejects bad usage", async () => {
    await expect(runCli(["nonsense"])).rejects.toThrow(/usage/);
    await expect(
      runCli(["run", "--title", "x", "--out", path.join(dir, "o")]),
    ).rejects.toThrow(/--input/);
  });
});
