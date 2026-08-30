/**
 * WorldImportDraft → Covel World Package export.
 *
 * Output (only what v1 needs — Covel tolerates missing pieces):
 *   world.yaml                  manifest (5 required fields + worldData)
 *   WORLD.md                    human-readable lore incl. provenance markers
 *   data/world.data.yaml        descriptor routing dimensions/cast/lore/rules
 *   data/dimensions.yaml        geography / factions / powerSystem / history
 *   data/lorebook.yaml          session lorebook entries
 *   data/rules/<id>-rules.yaml  living-world-rules entries
 *   characters/main-cast.json   character blueprints (effects: characters)
 *
 * Deterministic: same draft → byte-identical package. Enum fields Covel
 * requires (faction type/influence, climate, significance, …) use fixed
 * placeholders ("other" / "minor" / "原文未提及") — never invented lore.
 * Provenance markers: [推断] prefix for ai-inferred lorebook content,
 * [冲突待解] prefix + conflictNotes for conflicts. userEdited entries are
 * exported as the user left them.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { DraftEntry, WorldImportDraft } from "../types.js";

const CLIMATE_PLACEHOLDER = "原文未提及";

export interface ExportedPackageSummary {
  worldDir: string;
  files: string[];
  /** Entries whose content reached the package, by outcome. */
  counts: {
    entries: number;
    sourceBacked: number;
    aiInferred: number;
    conflict: number;
    userEdited: number;
  };
}

export async function exportCovelWorldPackage(
  draft: WorldImportDraft,
  worldDir: string,
): Promise<ExportedPackageSummary> {
  const files: string[] = [];
  const byType = groupByType(draft.entries);

  const dimensions = buildDimensions(byType);
  const cast = buildCast(byType.character);
  const rules = buildRules(byType.rule);
  const lorebook = buildLorebook(draft);

  const sources: Record<string, unknown> = {};
  if (dimensions) {
    await writeYaml(worldDir, "data/dimensions.yaml", dimensions);
    files.push("data/dimensions.yaml");
    sources.dimensions = {
      kind: "yaml",
      path: "data/dimensions.yaml",
      schema: "covel://world/dimensions",
      to: "world:metadata.dimensions",
    };
  }
  if (cast.length > 0) {
    await writeText(
      worldDir,
      "characters/main-cast.json",
      `${JSON.stringify(cast, null, 2)}\n`,
    );
    files.push("characters/main-cast.json");
    sources.cast = {
      kind: "json",
      path: "characters/main-cast.json",
      schema: "plugin://character-blueprint/blueprints",
      to: "plugin:character-blueprint/blueprints",
      key: "id",
      effects: ["characters"],
      ...(dimensions ? { after: "dimensions" } : {}),
    };
  }
  if (rules.length > 0) {
    const rulesPath = `data/rules/${draft.id}-rules.yaml`;
    await writeYaml(worldDir, rulesPath, rules);
    files.push(rulesPath);
    sources.rules = {
      kind: "yaml",
      path: rulesPath,
      schema: "plugin://living-world-rules/rules",
      to: "plugin:living-world-rules/rules+lorebook",
      key: "id",
      ...(dimensions ? { after: "dimensions" } : {}),
    };
  }
  if (lorebook.length > 0) {
    await writeYaml(worldDir, "data/lorebook.yaml", lorebook);
    files.push("data/lorebook.yaml");
    sources.lore = {
      kind: "yaml",
      path: "data/lorebook.yaml",
      to: "lorebook",
      key: "id",
      ...(dimensions ? { after: "dimensions" } : {}),
    };
  }

  await writeYaml(worldDir, "data/world.data.yaml", {
    schemaVersion: 1,
    sources,
  });
  files.push("data/world.data.yaml");

  const manifest: Record<string, unknown> = {
    schemaVersion: "1.0",
    id: draft.id,
    name: draft.title,
    version: "0.1.0",
    summary: draft.summary,
    defaultLocale: "zh-CN",
    worldData: "data/world.data.yaml",
  };
  await writeYaml(worldDir, "world.yaml", manifest);
  files.push("world.yaml");

  await writeText(worldDir, "WORLD.md", buildWorldMd(draft));
  files.push("WORLD.md");

  return {
    worldDir,
    files,
    counts: {
      entries: draft.entries.length,
      sourceBacked: draft.entries.filter(
        (e) => e.provenanceStatus === "source-backed",
      ).length,
      aiInferred: draft.entries.filter(
        (e) => e.provenanceStatus === "ai-inferred",
      ).length,
      conflict: draft.entries.filter((e) => e.provenanceStatus === "conflict")
        .length,
      userEdited: draft.entries.filter((e) => e.userEdited === true).length,
    },
  };
}

// ── File helpers ────────────────────────────────────────────────

async function writeYaml(
  worldDir: string,
  relPath: string,
  data: unknown,
): Promise<void> {
  await writeText(worldDir, relPath, stringifyYaml(data, { lineWidth: 0 }));
}

async function writeText(
  worldDir: string,
  relPath: string,
  text: string,
): Promise<void> {
  const filePath = path.join(worldDir, ...relPath.split("/"));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf-8");
}

// ── Dimensions ──────────────────────────────────────────────────

type EntriesByType = Record<string, DraftEntry[]>;

function groupByType(entries: DraftEntry[]): EntriesByType {
  const map: EntriesByType = {};
  for (const entry of entries) {
    (map[entry.type] ??= []).push(entry);
  }
  return map;
}

function buildDimensions(
  byType: EntriesByType,
): Record<string, unknown> | null {
  const dimensions: Record<string, unknown> = {};

  if (byType.location?.length) {
    dimensions.geography = {
      regions: byType.location.map((entry) => ({
        name: entry.name,
        description: entry.content,
        climate: CLIMATE_PLACEHOLDER,
      })),
    };
  }
  if (byType.faction?.length) {
    dimensions.factions = byType.faction.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.content,
      type: "other",
      influence: "minor",
    }));
  }
  if (byType.power?.length) {
    const powers = byType.power;
    dimensions.powerSystem =
      powers.length === 1
        ? {
            name: powers[0].name,
            type: "other",
            description: powers[0].content,
            rules: [powers[0].content],
          }
        : {
            name: "能力体系（导入归纳）",
            type: "other",
            description: powers
              .map((e) => `${e.name}：${e.content}`)
              .join("\n"),
            rules: powers.map((e) => `${e.name}：${e.content}`),
          };
  }
  if (byType.event?.length) {
    dimensions.history = byType.event.map((entry) => ({
      name: entry.name,
      description: entry.content,
      significance: "minor",
    }));
  }

  return Object.keys(dimensions).length > 0 ? dimensions : null;
}

// ── Characters ──────────────────────────────────────────────────

interface CharacterBlueprint {
  schemaVersion: 1;
  id: string;
  name: string;
  role: string;
  description: string;
  aliases: string[];
}

function buildCast(characters: DraftEntry[] | undefined): CharacterBlueprint[] {
  return (characters ?? []).map((entry) => ({
    schemaVersion: 1,
    id: entry.id,
    name: entry.name,
    role: "npc",
    description: entry.content,
    aliases: entry.aliases.filter((a) => a !== entry.name),
  }));
}

// ── Rules ───────────────────────────────────────────────────────

function buildRules(
  rules: DraftEntry[] | undefined,
): Array<Record<string, unknown>> {
  return (rules ?? []).map((entry) => ({
    schemaVersion: 1,
    id: entry.id,
    title: entry.name,
    content: entry.content,
    kind: "constant",
    category: "world",
    enabled: true,
  }));
}

// ── Lorebook ────────────────────────────────────────────────────

interface LorebookEntry {
  id: string;
  content: string;
  keys: string[];
  strategy: "selective" | "constant";
  insertionOrder: number;
}

const LOREBOOK_TYPES: Array<{ type: string; include: boolean }> = [
  { type: "character", include: true },
  { type: "faction", include: true },
  { type: "location", include: true },
  { type: "item", include: true },
  { type: "power", include: true },
  { type: "event", include: true },
  { type: "relationship", include: true },
  // rule entries are mirrored into the lorebook by the living-world-rules
  // plugin target itself; do not duplicate them here.
  { type: "rule", include: false },
];

function buildLorebook(draft: WorldImportDraft): LorebookEntry[] {
  const entries: LorebookEntry[] = [];
  let order = 100;

  for (const { type, include } of LOREBOOK_TYPES) {
    for (const entry of draft.entries.filter((e) => e.type === type)) {
      if (!include) continue;
      entries.push({
        id: entry.id,
        content: lorebookContent(entry),
        keys: lorebookKeys(entry),
        strategy: lorebookKeys(entry).length > 0 ? "selective" : "constant",
        insertionOrder: order,
      });
      order += 100;
    }
  }
  return entries;
}

function lorebookKeys(entry: DraftEntry): string[] {
  const keys = [entry.name, ...entry.aliases];
  return [...new Set(keys)];
}

function lorebookContent(entry: DraftEntry): string {
  if (entry.provenanceStatus === "conflict") {
    const notes = entry.conflictNotes
      ? `冲突说明：${entry.conflictNotes}。`
      : "";
    return `[冲突待解] ${entry.content} ${notes}`.trim();
  }
  if (entry.provenanceStatus === "ai-inferred") {
    return `[推断] ${entry.content}`;
  }
  return entry.content;
}

// ── WORLD.md ────────────────────────────────────────────────────

const TYPE_SECTION_TITLES: Record<string, string> = {
  character: "人物",
  faction: "势力",
  location: "地点",
  item: "物品",
  rule: "规则",
  power: "能力",
  event: "事件",
  relationship: "关系",
};

function statusLabel(entry: DraftEntry): string {
  if (entry.userEdited === true) return "已人工修订";
  switch (entry.provenanceStatus) {
    case "source-backed":
      return "有来源";
    case "ai-inferred":
      return "推断";
    case "conflict":
      return "冲突待解";
  }
}

function buildWorldMd(draft: WorldImportDraft): string {
  const lines: string[] = [];
  lines.push(`# ${draft.title}`, "");
  lines.push(`> ${draft.summary}`, "");
  const counts = {
    source: draft.entries.filter((e) => e.provenanceStatus === "source-backed")
      .length,
    inferred: draft.entries.filter((e) => e.provenanceStatus === "ai-inferred")
      .length,
    conflict: draft.entries.filter((e) => e.provenanceStatus === "conflict")
      .length,
  };
  lines.push(
    `> 导入来源 ${draft.sources.length} 个；条目 ${draft.entries.length} 条（有来源 ${counts.source}、推断 ${counts.inferred}、冲突待解 ${counts.conflict}）。`,
    "",
  );

  for (const [type, title] of Object.entries(TYPE_SECTION_TITLES)) {
    const group = draft.entries.filter((e) => e.type === type);
    if (group.length === 0) continue;
    lines.push(`## ${title}`, "");
    for (const entry of group) {
      lines.push(`### ${entry.name}（${statusLabel(entry)}）`, "");
      lines.push(entry.content, "");
      if (entry.conflictNotes) {
        lines.push(`> 冲突说明：${entry.conflictNotes}`, "");
      }
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
