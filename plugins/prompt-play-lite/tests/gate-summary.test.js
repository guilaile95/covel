import { describe, it, expect } from "vitest";
import { computeGateSummary } from "../../../scripts/dongfang/gate-summary.mjs";

describe("Gate summary accounting", () => {
  it("narrator + background + memory = total actual LLM calls", () => {
    const runtimeRows = [
      {
        runtimeId: "prompt-play-narrator",
        tokenUsage: JSON.stringify({ input: 20000, output: 800 }),
        durationMs: 450,
      },
      {
        runtimeId: "char-creator/character-tracker",
        tokenUsage: JSON.stringify({ inputTokens: 3000, outputTokens: 120 }),
        durationMs: 700,
      },
      { runtimeId: "pregame", tokenUsage: null, durationMs: 12 },
    ];
    const memoryRows = [
      { calls: 1, inputTokens: 1500, outputTokens: 90, durationMs: 1200 },
    ];
    const s = computeGateSummary(runtimeRows, memoryRows);
    expect(s.narratorCalls).toBe(1);
    expect(s.backgroundCalls).toBe(1);
    expect(s.memoryCalls).toBe(1);
    expect(s.totalCalls).toBe(3);
    expect(s.totalCalls).toBe(
      s.narratorCalls + s.backgroundCalls + s.memoryCalls,
    );
    expect(s.tokens.total.inputTokens).toBe(24500);
    expect(s.tokens.total.outputTokens).toBe(1010);
    expect(s.tokens.memory.inputTokens).toBe(1500);
    // latency buckets: narrator 450ms over 1 call, background 700ms, memory 1200ms
    expect(s.latencyMs.narrator).toEqual({ sumMs: 450, maxMs: 450 });
    expect(s.latencyMs.background.sumMs).toBe(700);
    expect(s.latencyMs.memory).toEqual({ sumMs: 1200, maxMs: 1200 });
  });

  it("Memory OFF shape: zero memory rows keep the total at runtime-only", () => {
    const runtimeRows = [
      {
        runtimeId: "prompt-play-narrator",
        tokenUsage: JSON.stringify({ inputTokens: 20000, outputTokens: 800 }),
      },
    ];
    const s = computeGateSummary(runtimeRows, []);
    expect(s.memoryCalls).toBe(0);
    expect(s.totalCalls).toBe(1);
    expect(s.totalCalls).toBe(
      s.narratorCalls + s.backgroundCalls + s.memoryCalls,
    );
  });

  it("memory retries count as separate calls", () => {
    const s = computeGateSummary(
      [],
      [
        { calls: 1, inputTokens: 100, outputTokens: 10 },
        { calls: 2, inputTokens: 200, outputTokens: 20 },
      ],
    );
    expect(s.memoryCalls).toBe(3);
    expect(s.totalCalls).toBe(3);
  });
});
