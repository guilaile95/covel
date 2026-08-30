import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ReviewPage } from "../components/review-page.js";
import { WorldImportDraftStore } from "../draft-store.js";
import { makeDraft } from "./model.test.js";

/**
 * Review workbench flow over a contract-valid draft: status filters,
 * decisions, save/reopen persistence, and the approve → world handoff.
 * The server seam and the router/session integrations are mocked at their
 * module boundaries.
 */

const {
  exportApprovedWorldMock,
  addWorldLocalMock,
  getWorldMock,
  navigateMock,
} = vi.hoisted(() => ({
  exportApprovedWorldMock: vi.fn(),
  addWorldLocalMock: vi.fn(),
  getWorldMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock("@/services/api/world-import.js", () => ({
  exportApprovedWorld: exportApprovedWorldMock,
  startWorldImport: vi.fn(),
  getWorldImportJob: vi.fn(),
}));

vi.mock("@/services/api/worlds.js", () => ({
  getWorld: getWorldMock,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ addWorldLocal: addWorldLocalMock }),
}));

let dbCounter = 0;
function newStore() {
  dbCounter += 1;
  return new WorldImportDraftStore(`test-review-flow-${dbCounter}`);
}

beforeEach(() => {
  vi.restoreAllMocks();
  exportApprovedWorldMock.mockReset();
  addWorldLocalMock.mockClear();
  getWorldMock.mockReset();
  navigateMock.mockClear();
});

afterEach(cleanup);

async function seedAndRender(store: WorldImportDraftStore) {
  const draft = makeDraft();
  await store.save(draft, { acceptedAi: [], resolvedConflicts: [] });
  render(<ReviewPage store={store} />);
  await screen.findByText("测试世界");
  return draft;
}

/** Re-render against an already-seeded store (no reseed, decisions kept). */
async function renderOnly(store: WorldImportDraftStore) {
  render(<ReviewPage store={store} />);
  await screen.findByText("测试世界");
}

/** Click the list item (first DOM occurrence) for an entry by name. */
function clickEntry(name: string) {
  const hit = screen.getAllByText(name)[0];
  const button = hit?.closest("button");
  if (!button) throw new Error(`list item button not found for ${name}`);
  fireEvent.click(button);
}

async function saveAll() {
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText(/已保存于/);
}

describe("World Import review flow", () => {
  it("shows the review overview with status + category filters", async () => {
    await seedAndRender(newStore());

    // Completion states on the list items.
    expect(screen.getAllByText("未审阅").length).toBe(4);
    // Review summary row + filter chip both carry the pending counter.
    expect(screen.getAllByText("待处理").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("已人工修改")).toBeDefined();

    // Status filter: pending hides the untouched source-backed character.
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    expect(screen.getByText("乙会")).toBeDefined();
    expect(screen.getByText("禁令")).toBeDefined();
    expect(screen.queryByText("林甲")).toBeNull();

    // Category filter combines with the status filter.
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    fireEvent.click(screen.getByRole("button", { name: "规则" }));
    expect(screen.getByText("禁令")).toBeDefined();
    expect(screen.queryByText("乙会")).toBeNull();
  });

  it("accepts an AI inference, saves, and the decision survives reopen", async () => {
    const store = newStore();
    await seedAndRender(store);

    clickEntry("乙会");
    fireEvent.click(
      await screen.findByRole("button", { name: "接受 AI 推断" }),
    );
    expect(screen.getAllByText("AI 已接受").length).toBeGreaterThan(0);

    await saveAll();
    cleanup();

    await renderOnly(store);
    await waitFor(() => {
      expect(screen.getAllByText("AI 已接受").length).toBeGreaterThan(0);
    });
    // Pending dropped to 1 — the accepted faction no longer pends.
    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    expect(screen.getByText("禁令")).toBeDefined();
    expect(screen.queryByText("乙会")).toBeNull();
  });

  it("resolves a conflict with edited notes; approval unlocks and hands over to the world", async () => {
    const store = newStore();
    const draft = await seedAndRender(store);

    // Approval is blocked while a conflict is unresolved.
    expect(
      screen
        .getByRole("button", { name: "批准并生成世界" })
        .hasAttribute("disabled"),
    ).toBe(true);

    clickEntry("禁令");
    const notes = await screen.findByRole("textbox", { name: "冲突说明" });
    fireEvent.change(notes, { target: { value: "以第二章为准。" } });
    fireEvent.click(screen.getByRole("button", { name: "标记冲突已解决" }));
    expect(screen.getAllByText("冲突已解决").length).toBeGreaterThan(0);
    await saveAll();
    cleanup();

    await renderOnly(store);
    // Wait for the reopened decisions to land.
    await waitFor(() => {
      expect(screen.getAllByText("冲突已解决").length).toBeGreaterThan(0);
    });
    const approveButton = screen.getByRole("button", {
      name: "批准并生成世界",
    });
    expect(approveButton.hasAttribute("disabled")).toBe(false);

    exportApprovedWorldMock.mockResolvedValue({
      world: { id: draft.id, name: "测试世界" },
      worldDirName: `imported-${draft.id}`,
      summary: { files: ["world.yaml"], counts: { entries: 4 } },
    });
    getWorldMock.mockResolvedValue({ id: draft.id, name: "测试世界" });
    fireEvent.click(approveButton);
    await screen.findByText("世界已生成");
    expect(exportApprovedWorldMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "test-draft" }),
      ["rule-1"],
    );

    // Start game pulls the generated world into the session store's list
    // and hands over to the existing world-select path.
    fireEvent.click(screen.getByRole("button", { name: "开始游戏" }));
    await waitFor(() => {
      expect(getWorldMock).toHaveBeenCalledWith(draft.id);
      expect(addWorldLocalMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: draft.id }),
      );
      expect(navigateMock).toHaveBeenCalled();
    });
  });

  it("shows loader failures verbatim instead of faking success", async () => {
    const store = newStore();
    await seedAndRender(store);

    clickEntry("禁令");
    fireEvent.click(
      await screen.findByRole("button", { name: "标记冲突已解决" }),
    );

    exportApprovedWorldMock.mockRejectedValue(
      new Error(
        "Covel world loader rejected the generated package (see server log for validation details)",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "批准并生成世界" }));
    await screen.findByText(/世界生成失败/);
    expect(screen.getByText(/Covel world loader rejected/)).toBeDefined();
    expect(screen.queryByText("世界已生成")).toBeNull();
  });
});
