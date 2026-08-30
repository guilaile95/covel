import { describe, it, expect } from "vitest";
import { createHookPipeline, runWithHookScope } from "@covel/runtime";
import register, { keepStoryOnly } from "../server/index.js";

// Runtime ids and outputKinds mirror the real bundled manifests:
// prompt-play-narrator (story), char-creator/character-tracker (system,
// core-plugin, scheduled every turn), guide (post-turn), npc-graph
// extractor (post-turn), pregame (setup, function).
const PASSTHROUGH_TRIGGERED = [
  { name: "pregame", outputKind: "system" },
  { name: "prompt-play-narrator", outputKind: "story" },
  { name: "char-creator/character-tracker", outputKind: "system" },
  { name: "guide", outputKind: "plugin" },
  { name: "npc-graph/extractor", outputKind: "system" },
];

describe("prompt-play-lite PreSchedule (keepStoryOnly)", () => {
  it("trims a passthrough turn down to the story runtime only", async () => {
    const r = await keepStoryOnly({ sessionId: "s1" }, { triggered: PASSTHROUGH_TRIGGERED });
    expect(r.action).toBe("continue");
    expect(r.replace).toBeDefined();
    expect(r.replace.triggered).toHaveLength(1);
    expect(r.replace.triggered[0].name).toBe("prompt-play-narrator");
    // the core background tracker must not survive the trim
    expect(r.replace.triggered.some((m) => m.name === "char-creator/character-tracker")).toBe(false);
  });

  it("leaves a non-passthrough world's trigger set untouched", async () => {
    const mistportLike = [
      { name: "narrator", outputKind: "story" },
      { name: "char-creator/character-tracker", outputKind: "system" },
      { name: "guide", outputKind: "plugin" },
    ];
    const r = await keepStoryOnly({ sessionId: "s2" }, { triggered: mistportLike });
    expect(r).toEqual({ action: "continue" });
    expect(r.replace).toBeUndefined();
  });

  it("takes the no-change fast path when only story runtimes are triggered", async () => {
    const only = [{ name: "prompt-play-narrator", outputKind: "story" }];
    const r = await keepStoryOnly({ sessionId: "s3" }, { triggered: only });
    expect(r).toEqual({ action: "continue" });
    expect(r.replace).toBeUndefined();
  });

  it("tolerates a missing triggered payload", async () => {
    const r = await keepStoryOnly({ sessionId: "s4" }, {});
    expect(r).toEqual({ action: "continue" });
  });
});

describe("prompt-play-lite plugin entry contract", () => {
  it("registers keepStoryOnly as the PreSchedule handler via covel.on", () => {
    const registered = [];
    const covelApi = {
      on: (event, handler) => registered.push([event, handler]),
    };
    expect(typeof register).toBe("function");
    register(covelApi);
    expect(registered).toHaveLength(1);
    expect(registered[0][0]).toBe("PreSchedule");
    expect(registered[0][1]).toBe(keepStoryOnly);
  });

  it("trims inside the real HookPipeline when wired like bootstrap/plugin-entry", async () => {
    const pipeline = createHookPipeline();
    // Wire the entry through the same shape bootstrap/plugin-entry.ts uses:
    // covel.on(event, handler) -> hookPipeline.register({ id, event, pluginId, handler })
    const covelApi = {
      on: (event, handler) =>
        pipeline.register({
          id: `prompt-play-lite:${event}:entry#1`,
          event,
          pluginId: "prompt-play-lite",
          handler,
        }),
    };
    register(covelApi);

    const run = (triggered, active) =>
      runWithHookScope(
        { activePluginIds: new Set(active) },
        () => pipeline.run("PreSchedule", { sessionId: "s-hp" }, { triggered }),
      );

    // passthrough session: the lite plugin is active -> hook fires and trims
    const active = [
      "prompt-play-lite",
      "prompt-play-narrator",
      "char-creator",
      "pregame",
      "memory",
    ];
    const r = await run(PASSTHROUGH_TRIGGERED, active);
    expect(r.action).toBe("continue");
    expect(r.replace).toBeDefined();
    expect(r.replace.triggered).toHaveLength(1);
    expect(r.replace.triggered[0].name).toBe("prompt-play-narrator");

    // plain mistport-like session: the lite plugin is NOT active -> the hook
    // is out of session scope and the trigger set passes through unchanged
    const mistportLike = [
      { name: "narrator", outputKind: "story" },
      { name: "char-creator/character-tracker", outputKind: "system" },
      { name: "guide", outputKind: "plugin" },
    ];
    const r2 = await run(mistportLike, ["mistport", "narrator", "char-creator"]);
    expect(r2).toEqual({ action: "continue" });
    expect(r2.replace).toBeUndefined();
  });
});
