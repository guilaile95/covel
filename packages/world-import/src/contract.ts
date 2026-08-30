/**
 * Browser-safe contract surface of @covel/world-import.
 *
 * The barrel entry (".") pulls in Node-only modules (node:crypto hashing,
 * node:path extractors, fs-writing exporter), so browser consumers — the
 * World Import review UI — import ONLY this subpath. It re-exports the
 * frozen v0 contract types and the pure draft validation/edit helpers,
 * nothing else.
 *
 * Keep this module free of Node builtins; add new pure contract helpers
 * here rather than to the barrel.
 */

export * from "./types.js";
export {
  serializeDraft,
  loadDraft,
  applyUserEdit,
  DraftContractError,
  type UserEditPatch,
} from "./draft.js";
