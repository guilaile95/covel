#!/usr/bin/env node
// Dongfang Gate A spike — per-turn LLM call/token/latency stats for one session.
// Read-only: opens the SQLite store and aggregates runtime_results.
//
// Usage:
//   node scripts/dongfang/turn-stats.mjs <sessionId> [path/to/covel.db]
//
// Default db paths tried (first existing wins):
//   ~/.covel/covel.db
//   ./data/covel.db (repo-local dev data root, when configured)

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const [, , sessionId, dbArg] = process.argv;
if (!sessionId) {
  console.error("usage: node scripts/dongfang/turn-stats.mjs <sessionId> [covel.db]");
  process.exit(1);
}

function findDb() {
  if (dbArg) return resolve(dbArg);
  const candidates = [
    join(homedir(), ".covel", "covel.db"),
    resolve("data/covel.db"),
    resolve("apps/server/data/covel.db"),
  ];
  const root = process.env.COVEL_DATA_ROOT;
  if (root) candidates.unshift(join(resolve(root), "covel.db"));
  for (const p of candidates) {
    try {
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  // Last resort: search common roots for *.db containing covel data.
  try {
    for (const f of readdirSync(resolve("data"))) {
      if (f.endsWith(".db")) return resolve("data", f);
    }
  } catch {}
  return null;
}

const dbPath = findDb();
if (!dbPath) {
  console.error("covel.db not found — pass the path explicitly as the 2nd argument.");
  process.exit(1);
}

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const rows = db
  .prepare(
    `SELECT turn_id AS turnId, plugin_id AS pluginId, runtime_id AS runtimeId,
            status, duration_ms AS durationMs, token_usage AS tokenUsage, created_at AS createdAt
       FROM runtime_results WHERE session_id = ? ORDER BY created_at`,
  )
  .all(sessionId);

if (rows.length === 0) {
  console.error(`no runtime_results for session ${sessionId} in ${dbPath}`);
  process.exit(1);
}

const NARRATOR = "prompt-play-narrator";
const turns = new Map();
for (const r of rows) {
  if (!turns.has(r.turnId)) {
    turns.set(r.turnId, { turnId: r.turnId, entries: [] });
  }
  turns.get(r.turnId).entries.push(r);
}

function tokens(raw) {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw);
    // usage shapes vary by adapter; normalize common fields
    const input = u.inputTokens ?? u.prompt_tokens ?? u.input?.tokens ?? u.input_tokens ?? null;
    const output = u.outputTokens ?? u.completion_tokens ?? u.output?.tokens ?? u.output_tokens ?? null;
    return { input, output, raw: u };
  } catch {
    return null;
  }
}

let grandCalls = 0;
let grandIn = 0;
let grandOut = 0;
let grandNarrIn = 0;
let grandNarrOut = 0;

console.log(`session ${sessionId} — ${dbPath}`);
console.log("─".repeat(100));
for (const { turnId, entries } of turns.values()) {
  const llm = entries.filter((e) => tokens(e.tokenUsage) !== null);
  const narr = llm.filter((e) => e.runtimeId === NARRATOR || e.pluginId === NARRATOR);
  const back = llm.filter((e) => !narr.includes(e));
  const sum = (list) =>
    list.reduce(
      (acc, e) => {
        const t = tokens(e.tokenUsage);
        return { in: acc.in + (t.input ?? 0), out: acc.out + (t.output ?? 0) };
      },
      { in: 0, out: 0 },
    );
  const narrSum = sum(narr);
  const backSum = sum(back);
  const maxDur = Math.max(...entries.map((e) => e.durationMs ?? 0));
  grandCalls += llm.length;
  grandIn += narrSum.in + backSum.in;
  grandOut += narrSum.out + backSum.out;
  grandNarrIn += narrSum.in;
  grandNarrOut += narrSum.out;
  console.log(
    `turn ${turnId}: ${llm.length} LLM call(s)` +
      ` | narrative ${narr.length} (in ${narrSum.in} / out ${narrSum.out} tok)` +
      ` | background ${back.length}${back.length ? ` (in ${backSum.in} / out ${backSum.out} tok)` : ""}` +
      ` | slowest runtime ${maxDur}ms`,
  );
  for (const e of entries) {
    const t = tokens(e.tokenUsage);
    console.log(
      `   · ${e.pluginId}/${e.runtimeId} [${e.status}] ${e.durationMs}ms` +
        (t ? ` tokens in ${t.input ?? "?"} out ${t.output ?? "?"}` : " (no LLM)"),
    );
  }
}
console.log("─".repeat(100));
console.log(
  `TOTAL turns=${turns.size} llmCalls=${grandCalls} tokens in=${grandIn} out=${grandOut}` +
    ` | narrative in=${grandNarrIn} out=${grandNarrOut}` +
    ` | background in=${grandIn - grandNarrIn} out=${grandOut - grandNarrOut}`,
);
