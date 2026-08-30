// Gate A (Dongfang) summary math.
// The Gate's accounting rule: every actual LLM call is counted exactly once as
//   narrator calls + background (runtime) calls + memory updater calls = total.
// runtime rows come from runtime_results (LLM rows = those with tokenUsage),
// memory rows come from trace_events type "memory.llm" (see post-turn-memory.ts).

/**
 * @param {Array<{runtimeId?: string, pluginId?: string, tokenUsage?: string|null}>} runtimeRows
 * @param {Array<{calls?: number, inputTokens?: number, outputTokens?: number}>} memoryRows
 */
export function computeGateSummary(runtimeRows, memoryRows) {
  let narratorCalls = 0;
  let backgroundCalls = 0;
  let narratorIn = 0;
  let narratorOut = 0;
  let backgroundIn = 0;
  let backgroundOut = 0;
  let narratorLatencySum = 0;
  let narratorLatencyMax = 0;
  let backgroundLatencySum = 0;
  let backgroundLatencyMax = 0;
  for (const r of runtimeRows) {
    if (!r.tokenUsage) continue; // function runtimes make no LLM call
    const id = String(r.runtimeId ?? r.pluginId ?? "");
    const usage = parseUsage(r.tokenUsage);
    const isNarrator = id.includes("narrator");
    const dur = r.durationMs ?? 0;
    if (isNarrator) {
      narratorCalls += 1;
      narratorIn += usage.inputTokens;
      narratorOut += usage.outputTokens;
      narratorLatencySum += dur;
      narratorLatencyMax = Math.max(narratorLatencyMax, dur);
    } else {
      backgroundCalls += 1;
      backgroundIn += usage.inputTokens;
      backgroundOut += usage.outputTokens;
      backgroundLatencySum += dur;
      backgroundLatencyMax = Math.max(backgroundLatencyMax, dur);
    }
  }

  let memoryCalls = 0;
  let memoryIn = 0;
  let memoryOut = 0;
  let memoryLatencySum = 0;
  let memoryLatencyMax = 0;
  for (const m of memoryRows ?? []) {
    memoryCalls += m.calls ?? 1;
    memoryIn += m.inputTokens ?? 0;
    memoryOut += m.outputTokens ?? 0;
    memoryLatencySum += m.durationMs ?? 0;
    memoryLatencyMax = Math.max(memoryLatencyMax, m.durationMs ?? 0);
  }

  return {
    narratorCalls,
    backgroundCalls,
    memoryCalls,
    totalCalls: narratorCalls + backgroundCalls + memoryCalls,
    tokens: {
      narrator: { inputTokens: narratorIn, outputTokens: narratorOut },
      background: { inputTokens: backgroundIn, outputTokens: backgroundOut },
      memory: { inputTokens: memoryIn, outputTokens: memoryOut },
      total: {
        inputTokens: narratorIn + backgroundIn + memoryIn,
        outputTokens: narratorOut + backgroundOut + memoryOut,
      },
    },
    latencyMs: {
      // sum of per-call durations per bucket, plus the slowest single call
      narrator: { sumMs: narratorLatencySum, maxMs: narratorLatencyMax },
      background: { sumMs: backgroundLatencySum, maxMs: backgroundLatencyMax },
      memory: { sumMs: memoryLatencySum, maxMs: memoryLatencyMax },
    },
  };
}

function parseUsage(raw) {
  try {
    const u = JSON.parse(raw);
    return {
      inputTokens: u.inputTokens ?? u.input ?? u.prompt_tokens ?? 0,
      outputTokens: u.outputTokens ?? u.output ?? u.completion_tokens ?? 0,
    };
  } catch {
    return { inputTokens: 0, outputTokens: 0 };
  }
}
