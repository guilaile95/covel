import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createWorldImportRoutes } from "../../src/routes/api/world-import/index.js";
import { SYNTHETIC_NOVEL_TXT } from "../../src/routes/api/world-import/fake-rules.js";

let store: DataStore;
let worldsRoot: string;
let app: Hono<{
  Variables: { store: DataStore; worldsDirs?: readonly string[] };
}>;

beforeEach(async () => {
  store = createMemoryStore();
  worldsRoot = await mkdtemp(path.join(tmpdir(), "world-import-test-"));
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("worldsDirs", [worldsRoot]);
    await next();
  });
  app.route("/api/world-import", createWorldImportRoutes());
});

afterEach(async () => {
  await rm(worldsRoot, { recursive: true, force: true });
});

function importForm(title = "雾港旧事"): FormData {
  const form = new FormData();
  form.set("title", title);
  form.append(
    "files",
    new File([SYNTHETIC_NOVEL_TXT], "雾港旧事.txt", { type: "text/plain" }),
  );
  return form;
}

async function runImportToDone(title = "雾港旧事") {
  const created = await app.request("/api/world-import/import", {
    method: "POST",
    body: importForm(title),
  });
  expect(created.status).toBe(201);
  const { jobId } = (await created.json()) as { jobId: string };

  const job = await vi.waitFor(async () => {
    const res = await app.request(`/api/world-import/jobs/${jobId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      draft?: unknown;
      error?: string;
    };
    if (body.status === "running") {
      throw new Error("job still running");
    }
    return body;
  });
  return job as {
    status: "done" | "error";
    draft?: unknown;
    error?: string;
    stats?: Record<string, number>;
  };
}

describe("POST /api/world-import/import", () => {
  it("rejects a missing title", async () => {
    const form = importForm();
    form.set("title", "  ");
    const res = await app.request("/api/world-import/import", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it("rejects unsupported file types", async () => {
    const form = new FormData();
    form.set("title", "x");
    form.append("files", new File(["manga"], "pages.pdf"));
    const res = await app.request("/api/world-import/import", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it("runs the pipeline to a contract-valid draft with conflict + AI entries", async () => {
    const job = await runImportToDone();
    expect(job.status).toBe("done");
    expect(job.error).toBeUndefined();

    const draft = job.draft as {
      version: number;
      title: string;
      entries: Array<{
        id: string;
        name: string;
        provenanceStatus: string;
      }>;
    };
    expect(draft.version).toBe(0);
    expect(draft.title).toBe("雾港旧事");
    const names = draft.entries.map((e) => e.name);
    expect(names).toContain("林一舟");
    expect(names).toContain("雾港务局");
    expect(names).toContain("陈半潮");
    expect(names).toContain("观潮石");
    // conflict from clashing claims across chapters
    expect(draft.entries.some((e) => e.provenanceStatus === "conflict")).toBe(
      true,
    );
    // pure AI inference without source paragraphs
    expect(
      draft.entries.some((e) => e.provenanceStatus === "ai-inferred"),
    ).toBe(true);
  });

  it("404s for an unknown job id", async () => {
    const res = await app.request("/api/world-import/jobs/nope");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/world-import/export", () => {
  it("rejects drafts that violate the frozen contract", async () => {
    const res = await app.request("/api/world-import/export", {
      method: "POST",
      body: JSON.stringify({ draft: { version: 99 } }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("409s while a conflict entry is unresolved", async () => {
    const job = await runImportToDone();
    const draft = job.draft;
    const res = await app.request("/api/world-import/export", {
      method: "POST",
      body: JSON.stringify({ draft, resolvedConflictIds: [] }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(409);
  });

  it("generates a Covel world package the loader accepts, then upserts the world", async () => {
    const job = await runImportToDone();
    const draft = job.draft as {
      id: string;
      entries: Array<{ id: string; provenanceStatus: string }>;
    };
    const resolvedConflictIds = draft.entries
      .filter((e) => e.provenanceStatus === "conflict")
      .map((e) => e.id);

    const res = await app.request("/api/world-import/export", {
      method: "POST",
      body: JSON.stringify({ draft, resolvedConflictIds }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      world: { id: string; name: string };
      worldDirName: string;
      summary: { files: string[] };
    };
    expect(body.world.id).toBe(draft.id);
    expect(body.world.name).toBe("雾港旧事");
    expect(body.worldDirName).toBe(`imported-${draft.id}`);
    expect(body.summary.files).toContain("world.yaml");

    // The generated package is on disk under the target root…
    const dirs = await readdir(worldsRoot);
    expect(dirs).toContain(`imported-${draft.id}`);
    // …passed the server loader, and was upserted into the store.
    const stored = await store.getWorld(draft.id);
    expect(stored).not.toBeNull();
    expect(stored?.name).toBe("雾港旧事");
  });
});
