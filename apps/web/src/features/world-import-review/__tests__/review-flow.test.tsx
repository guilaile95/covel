import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReviewPage } from "../components/review-page.js";
import { WorldImportDraftStore } from "../draft-store.js";
import { makeDraft } from "./model.test.js";

const { exportApprovedWorldMock, addWorldLocalMock, getWorldMock, navigateMock } =
  vi.hoisted(() => ({
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

vi.mock("@/services/api/worlds.js", () => ({ getWorld: getWorldMock }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ addWorldLocal: addWorldLocalMock }),
}));

let dbCounter = 0;
function newStore() {
  dbCounter += 1;
  return new WorldImportDraftStore(`test-review-flow-${dbCounter}`);
}

beforeEach(() => {
  exportApprovedWorldMock.mockReset();
  addWorldLocalMock.mockReset();
  getWorldMock.mockReset();
  navigateMock.mockReset();
});

afterEach(cleanup);

async function seedAndRender(store: WorldImportDraftStore) {
  const draft = makeDraft();
  await store.save(draft);
  render(<ReviewPage store={store} />);
  await screen.findByText("测试世界");
  return draft;
}

function clickEntry(name: string) {
  const button = screen.getAllByText(name)[0]?.closest("button");
  if (!button) throw new Error(`list item button not found for ${name}`);
  fireEvent.click(button);
}

async function saveDraft() {
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText(/已保存于/);
}

describe("World Import review flow", () => {
  it("writes decisions into the draft, keeps conflict notes read-only, and persists them", async () => {
    const store = newStore();
    await seedAndRender(store);

    clickEntry("乙会");
    fireEvent.click(await screen.findByRole("button", { name: "接受 AI 推断" }));
    expect(screen.getAllByText("AI 已接受").length).toBeGreaterThan(0);

    clickEntry("禁令");
    expect(screen.queryByRole("textbox", { name: "冲突说明" })).toBeNull();
    expect(screen.getByText("机器生成的冲突指纹")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "标记冲突已解决" }));
    expect(screen.queryByRole("button", { name: "标记冲突已解决" })).toBeNull();

    await saveDraft();
    cleanup();
    render(<ReviewPage store={store} />);
    await screen.findByText("测试世界");

    fireEvent.click(screen.getByRole("button", { name: "待处理" }));
    expect(screen.queryByText("乙会")).toBeNull();
    expect(screen.queryByText("禁令")).toBeNull();
    const reloaded = await store.loadLatest();
    expect(
      reloaded?.draft.entries.find((entry) => entry.id === "ai-1")?.aiAccepted,
    ).toBe(true);
    expect(
      reloaded?.draft.entries.find((entry) => entry.id === "rule-1")
        ?.conflictResolved,
    ).toBe(true);
  });

  it("approves with only the canonical draft and does not fake loader success", async () => {
    const store = newStore();
    const draft = await seedAndRender(store);
    clickEntry("禁令");
    fireEvent.click(screen.getByRole("button", { name: "标记冲突已解决" }));

    exportApprovedWorldMock.mockResolvedValueOnce({
      world: { id: draft.id, name: draft.title },
      worldDirName: `imported-${draft.id}`,
      summary: { files: ["world.yaml"], counts: { entries: 4 } },
    });
    fireEvent.click(screen.getByRole("button", { name: "批准并生成世界" }));
    await screen.findByText("世界已生成");
    expect(exportApprovedWorldMock).toHaveBeenCalledTimes(1);
    const [approved] = exportApprovedWorldMock.mock.calls[0] as [typeof draft];
    expect(approved.id).toBe(draft.id);
    expect(approved.entries.find((entry) => entry.id === "rule-1")?.conflictResolved).toBe(true);
    expect(exportApprovedWorldMock.mock.calls[0]).toHaveLength(1);

    cleanup();
    const failingStore = newStore();
    await seedAndRender(failingStore);
    clickEntry("禁令");
    fireEvent.click(screen.getByRole("button", { name: "标记冲突已解决" }));
    exportApprovedWorldMock.mockRejectedValueOnce(
      new Error("Covel world loader rejected the generated package"),
    );
    fireEvent.click(screen.getByRole("button", { name: "批准并生成世界" }));
    await screen.findByText(/Covel world loader rejected/);
    await waitFor(() => expect(screen.queryByText("世界已生成")).toBeNull());
  });
});
