import Dexie, { type Table } from "dexie";
import { parseDraft, type WorldImportDraft } from "./model.js";

/**
 * Local persistence for the world-import review working copy, so a saved
 * draft (decisions included — they are canonical entry fields now) survives
 * refresh / reopen. Deliberately a small dedicated database — game data
 * lives in BrowserVault and must not be mixed with review-only state.
 */

export const WORLD_IMPORT_DRAFT_DB_NAME = "covel-world-import-review";

interface DraftRecord {
  readonly draftId: string;
  readonly savedAt: string;
  readonly draft: WorldImportDraft;
}

export interface SavedDraft {
  readonly savedAt: string;
  readonly draft: WorldImportDraft;
}

export class WorldImportDraftStore {
  private readonly db: Dexie;
  private readonly drafts: Table<DraftRecord, string>;

  constructor(dbName: string = WORLD_IMPORT_DRAFT_DB_NAME) {
    this.db = new Dexie(dbName);
    this.db.version(1).stores({ drafts: "draftId" });
    this.drafts = this.db.table("drafts");
  }

  async load(draftId: string): Promise<SavedDraft | null> {
    const record = await this.drafts.get(draftId);
    if (!record) return null;
    return this.validateRecord(draftId, record);
  }

  /**
   * The review keeps a single working draft; pick the most recently saved
   * record without the caller needing to know its id.
   */
  async loadLatest(): Promise<SavedDraft | null> {
    const all = await this.drafts.toArray();
    if (all.length === 0) return null;
    const latest = all.reduce((a, b) => (a.savedAt >= b.savedAt ? a : b));
    return this.validateRecord(latest.draftId, latest);
  }

  async save(draft: WorldImportDraft): Promise<string> {
    const savedAt = new Date().toISOString();
    await this.drafts.put({
      draftId: draft.id,
      savedAt,
      draft,
    });
    return savedAt;
  }

  async clear(draftId: string): Promise<void> {
    await this.drafts.delete(draftId);
  }

  /**
   * Last-resort recovery when a stored record fails contract validation
   * (e.g. legacy drafts left by an older build): wipe the local review
   * database so the owner can import again.
   */
  async clearAll(): Promise<void> {
    await this.drafts.clear();
  }

  private validateRecord(
    draftId: string,
    record: DraftRecord,
  ): SavedDraft | null {
    // Validate on read: a corrupted or schema-drifted record must fail
    // loudly instead of feeding broken data into the review UI. Legacy
    // records from the decisions-map era carry an ignored `decisions`
    // field — its data lives in the canonical draft from now on.
    const parsed = parseDraft(record.draft);
    if (!parsed.ok) {
      throw new Error(
        `Saved draft "${draftId}" failed contract validation: ${parsed.error}`,
      );
    }
    return { savedAt: record.savedAt, draft: parsed.draft };
  }
}
