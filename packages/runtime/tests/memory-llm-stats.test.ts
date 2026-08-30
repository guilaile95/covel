/**
 * Gate A (Dongfang) — fake-LLM stats for the post-turn memory updater.
 *
 * The memory updater is invoked directly by the framework, not as a runtime,
 * so its LLM call must be counted via the dedicated memory.llm trace row:
 *   Memory OFF (no memorySystem)        -> 0 memory LLM calls
 *   Memory ON  (fake updater resolves)  -> exactly 1 memory LLM call, with
 *                                          session/turn correlation.
 */
import { describe, it, expect, vi } from "vitest";
import type { TurnInput, TurnResult } from "@covel/shared";
import { schedulePostTurnMemoryUpdate } from "../src/turn-executor/post-turn-memory.js";

const SID = "sess-mem-stats";
const TURN_ID = "turn-mem-1";

function makeTurnResult(): TurnResult {
  return {
    turnId: TURN_ID,
    runtimeResults: [
      {
        pluginId: "prompt-play-narrator",
        runtimeId: "prompt-play-narrator",
        status: "success",
        output: { narrativeOutput: "老槐树下，你等到了师姐。" },
        toolCalls: [],
      },
    ],
  } as unknown as TurnResult;
}

function makeInput(): TurnInput {
  return { sessionId: SID, locale: "zh-CN" } as unknown as TurnInput;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const addTraceEvent = vi.fn(async () => {});
  const updater = {
    updateAfterTurn: vi.fn(async () => ({
      updated: true,
      blocksChanged: ["current_plot"],
      usage: { inputTokens: 111, outputTokens: 22 },
      llmCalls: 1,
    })),
    awaitPending: async () => {},
  };
  const deps = {
    store: { addTraceEvent },
    memorySystem: { updater },
    ...overrides,
  };
  return { deps, addTraceEvent, updater };
}

async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 10));
}

describe("post-turn memory LLM instrumentation (fake LLM)", () => {
  it("Memory OFF: no memorySystem -> 0 memory LLM calls, no trace rows", async () => {
    const { deps, addTraceEvent, updater } = makeDeps({
      memorySystem: undefined,
    });
    schedulePostTurnMemoryUpdate({
      input: makeInput(),
      turnResult: makeTurnResult(),
      deps: deps as never,
      coreMemoryBlocks: [],
    });
    await flushMicrotasks();
    expect(updater.updateAfterTurn).not.toHaveBeenCalled();
    const memRows = addTraceEvent.mock.calls.filter(
      (c) => c[0]?.type === "memory.llm",
    );
    expect(memRows).toHaveLength(0);
  });

  it("Memory ON: fake updater resolves -> exactly 1 memory LLM call with usage and session/turn correlation", async () => {
    const { deps, addTraceEvent, updater } = makeDeps();
    schedulePostTurnMemoryUpdate({
      input: makeInput(),
      turnResult: makeTurnResult(),
      deps: deps as never,
      coreMemoryBlocks: [{ label: "current_plot" } as never],
    });
    await flushMicrotasks();
    expect(updater.updateAfterTurn).toHaveBeenCalledTimes(1);
    const memRows = addTraceEvent.mock.calls.filter(
      (c) => c[0]?.type === "memory.llm",
    );
    expect(memRows).toHaveLength(1);
    const row = memRows[0][0];
    expect(row.sessionId).toBe(SID);
    expect(row.turnId).toBe(TURN_ID);
    expect(row.payload.calls).toBe(1);
    expect(row.payload.inputTokens).toBe(111);
    expect(row.payload.outputTokens).toBe(22);
    expect(typeof row.payload.durationMs).toBe("number");
  });

  it("Memory ON with a failing updater still records the attempted call", async () => {
    const addTraceEvent = vi.fn(async () => {});
    const updater = {
      updateAfterTurn: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      awaitPending: async () => {},
    };
    schedulePostTurnMemoryUpdate({
      input: makeInput(),
      turnResult: makeTurnResult(),
      deps: {
        store: { addTraceEvent },
        memorySystem: { updater },
      } as never,
      coreMemoryBlocks: [{ label: "current_plot" } as never],
    });
    await flushMicrotasks();
    expect(updater.updateAfterTurn).toHaveBeenCalledTimes(1);
    const memRows = addTraceEvent.mock.calls.filter(
      (c) => c[0]?.type === "memory.llm",
    );
    expect(memRows).toHaveLength(1);
    expect(memRows[0][0].payload.calls).toBe(1);
    expect(memRows[0][0].payload.error).toContain("connection refused");
  });
});
