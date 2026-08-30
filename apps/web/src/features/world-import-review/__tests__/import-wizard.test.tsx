import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ImportWizard } from "../components/import-wizard.js";
import { makeDraft } from "./model.test.js";

/**
 * The real intake path at the component level: name + files → job started →
 * staged progress → contract-validated draft handed to review. The server
 * seam is mocked at the module boundary.
 */

const { startWorldImportMock, getWorldImportJobMock } = vi.hoisted(() => ({
  startWorldImportMock: vi.fn(),
  getWorldImportJobMock: vi.fn(),
}));

vi.mock("@/services/api/world-import.js", () => ({
  startWorldImport: startWorldImportMock,
  getWorldImportJob: getWorldImportJobMock,
}));

beforeEach(() => {
  vi.restoreAllMocks();
  startWorldImportMock.mockReset();
  getWorldImportJobMock.mockReset();
});

afterEach(cleanup);

function attachFiles(input: Element, files: File[]) {
  Object.defineProperty(input, "files", { value: files });
  fireEvent.change(input);
}

describe("ImportWizard", () => {
  it("validates title and files before starting", async () => {
    render(<ImportWizard onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "开始导入" }));
    expect(await screen.findByText("请先输入世界名称。")).toBeDefined();

    fireEvent.change(screen.getByRole("textbox", { name: "世界名称" }), {
      target: { value: "雾港旧事" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始导入" }));
    expect(await screen.findByText("请至少选择一个来源文件。")).toBeDefined();
    expect(startWorldImportMock).not.toHaveBeenCalled();
  });

  it("uploads files, shows progress, and hands the parsed draft to review", async () => {
    const draft = makeDraft();
    const onImported = vi.fn();
    render(<ImportWizard onImported={onImported} />);

    fireEvent.change(screen.getByRole("textbox", { name: "世界名称" }), {
      target: { value: "雾港旧事" },
    });
    attachFiles(document.querySelector('input[type="file"]')!, [
      new File(["第一章 雾港\n林一舟"], "雾港旧事.txt", { type: "text/plain" }),
    ]);
    expect(screen.getByText("雾港旧事.txt")).toBeDefined();

    startWorldImportMock.mockResolvedValue({ jobId: "job-1" });
    // One extracting poll, then B Job Core completion.
    getWorldImportJobMock
      .mockResolvedValueOnce({
        jobId: "job-1",
        status: "extracting",
        stage: "extracting",
        processedChunks: 1,
        chunksTotal: 3,
      })
      .mockResolvedValue({
        jobId: "job-1",
        status: "completed",
        stage: "completed",
        processedChunks: 3,
        chunksTotal: 3,
        draft,
      });

    fireEvent.click(screen.getByRole("button", { name: "开始导入" }));
    expect(startWorldImportMock).toHaveBeenCalledWith("雾港旧事", [
      expect.any(File),
    ]);

    await screen.findByText(/抽取中/);
    await vi.waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
    expect(onImported).toHaveBeenCalledWith(draft);
  });

  it("surfaces job errors verbatim", async () => {
    render(<ImportWizard onImported={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "世界名称" }), {
      target: { value: "雾港旧事" },
    });
    attachFiles(document.querySelector('input[type="file"]')!, [
      new File(["x"], "bad.epub"),
    ]);
    startWorldImportMock.mockResolvedValue({ jobId: "job-2" });
    getWorldImportJobMock.mockResolvedValue({
      jobId: "job-2",
      status: "failed",
      stage: "failed",
      processedChunks: 0,
      chunksTotal: 0,
      error: "invalid epub: missing container.xml",
    });

    fireEvent.click(screen.getByRole("button", { name: "开始导入" }));
    await screen.findByText(/invalid epub/);
  });
});
