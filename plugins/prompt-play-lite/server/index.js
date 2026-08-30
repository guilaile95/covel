/**
 * Prompt Play Lite — entry module.
 *
 * Covel plugin-entry contract: the default export is an init factory that
 * receives the `covel` API and registers lifecycle hooks on it. The handler
 * itself is a named export so tests can call it directly.
 */

const PASSTHROUGH_NARRATOR_ID = "prompt-play-narrator";

function runtimeId(manifest) {
  return String(
    manifest?.name ?? manifest?.id ?? manifest?.pluginId ?? "",
  );
}

/**
 * PreSchedule — for passthrough (Prompt Play) sessions, keep only the story
 * runtime (prompt-play-narrator) in the main loop and drop every background
 * agent (character-tracker, guide, codex, npc-graph extractor, ...).
 *
 * Identification is capability-shaped, never a hardcoded session list: the
 * trim engages only when the passthrough narrator itself is in this turn's
 * triggered set. Any other session never sees it and takes the no-change
 * fast path.
 *
 * Setup-stage runtimes are force-retained by the framework regardless of this
 * hook (see turn-executor retainPreGameRuntimes); passthrough worlds rely on
 * their zero-LLM setup paths instead (function pregame, declared
 * characterAttributes for schema-gen, the player-init passthrough guard).
 *
 * @param {{ sessionId: string }} ctx
 * @param {{ triggered: ReadonlyArray<Record<string, unknown>> }} payload
 * @returns {Promise<{ action: "continue", replace?: { triggered: ReadonlyArray<unknown> } }>}
 */
export async function keepStoryOnly(ctx, payload) {
  const triggered = payload?.triggered ?? [];
  const isPassthroughTurn = triggered.some(
    (m) => runtimeId(m) === PASSTHROUGH_NARRATOR_ID,
  );
  if (!isPassthroughTurn) return { action: "continue" };

  const kept = triggered.filter((m) => {
    if (!m) return false;
    if (runtimeId(m) === PASSTHROUGH_NARRATOR_ID) return true;
    return m.outputKind === "story";
  });
  if (kept.length === triggered.length) return { action: "continue" };
  return { action: "continue", replace: { triggered: kept } };
}

/**
 * Plugin entry — register the PreSchedule hook on the covel API.
 * @param {{ on: Function }} covel
 */
export default function register(covel) {
  covel.on("PreSchedule", keepStoryOnly);
}
