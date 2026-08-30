import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  LlmExtractionAdapter,
  createFakeExtractionBackend,
  extractionResponse,
} from "@covel/world-import";
import {
  loadDraft,
  markAiAccepted,
  markConflictResolved,
} from "@covel/world-import/contract";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createWorldImportRoutes } from "../../src/routes/api/world-import/index.js";

/**
 * The full World Import loop over HTTP with B's real pieces: LlmExtraction
 * Adapter driven by a scripted fake Covel backend (never a paid model) →
 * B's Job Core → canonical draft → owner decisions via contract helpers →
 * export gate → Covel World Package → provenance-marker assertions →
 * Covel world loader → store upsert.
 */

const SYNTHETIC_NOVEL_TXT = `第一章 雾港

雾港的清晨总是从雾里开始的。林一舟站在领航员的瞭望位上，看着雾港务局的巡船慢慢驶出防波堤。

港务局的铜钟敲了三下，意味着潮水已经涨到码头第三级台阶。

第二章 灯塔

陈半潮守着灯塔，码头的人都叫他半潮伯。他教林一舟辨认观潮石上的水痕。

大雾封港的黄昏，港务局的巡船全部回港，林一舟却在雾里看见了一盏不该存在的灯。

第三章 对账

雾散之后，林一舟去港务局对账。半潮伯说，规矩就是规矩。

大雾封港的午夜，灯塔的光会准时扫过观潮石。
`;

function sourceBacked(
  type: string,
  name: string,
  content: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type,
    name,
    content,
    status: "source-backed",
    paragraphs: [1],
    ...extra,
  };
}

/**
 * Chunk-scoped model responses: the novel chunks deterministically (one per
 * chapter), so backend call N is chapter N. Call 0 = 雾港, call 1 = 灯塔,
 * call 2 = 对账.
 */
const KEYWORD_SCRIPT = [
  {
    call: 0,
    ...extractionResponse([
      sourceBacked("character", "林一舟", "雾港最年轻的领航员。"),
      sourceBacked("faction", "雾港务局", "掌管雾港航道与封港令的机构。"),
    ]),
  },
  {
    call: 1,
    ...extractionResponse([
      sourceBacked("character", "陈半潮", "灯塔的老守灯人。", {
        aliases: ["半潮伯"],
      }),
      sourceBacked("location", "观潮石", "港外礁石上的观测点。"),
      sourceBacked("rule", "大雾封港规程", "大雾封港期间禁止出港。", {
        claims: [{ field: "封港生效时间", value: "黄昏起生效" }],
      }),
      {
        // AI inference: the contract forbids paragraphs on ai-inferred output.
        type: "relationship",
        name: "林一舟与陈半潮",
        content: "推断两人是师徒。",
        status: "ai-inferred",
      },
    ]),
  },
  {
    call: 2,
    ...extractionResponse([
      // Same claim field, different value → merge marks the rule entry as a
      // conflict for the owner to resolve.
      sourceBacked("rule", "大雾封港规程", "大雾封港期间禁止出港。", {
        claims: [{ field: "封港生效时间", value: "午夜起生效" }],
      }),
    ]),
  },
  {
    // Default for unexpected extra chunks.
    ...extractionResponse([]),
  },
];

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
  // Production adapter shape (LlmExtractionAdapter) with a scripted fake
  // Covel backend — the same buildAdapter seam the route uses for tests.
  app.route(
    "/api/world-import",
    createWorldImportRoutes({
      buildAdapter: () =>
        new LlmExtractionAdapter({
          backend: createFakeExtractionBackend(KEYWORD_SCRIPT),
          model: "test-slot",
        }),
    }),
  );
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

interface JobView {
  jobId: string;
  status: string;
  draft?: {
    id: string;
    title: string;
    entries: Array<{
      id: string;
      name: string;
      type: string;
      provenanceStatus: string;
      conflictNotes?: string;
      aiAccepted?: boolean;
      conflictResolved?: boolean;
      userEdited?: boolean;
    }>;
  };
  error?: string;
}

async function runImportToDone(title = "雾港旧事"): Promise<JobView> {
  const created = await app.request("/api/world-import/import", {
    method: "POST",
    body: importForm(title),
  });
  expect(created.status).toBe(201);
  const { jobId } = (await created.json()) as { jobId: string };

  for (let attempt = 0; attempt < 100; attempt++) {
    const res = await app.request(`/api/world-import/jobs/${jobId}`);
    expect(res.status).toBe(200);
    const job = (await res.json()) as JobView;
    // completed is set just before the registry captures the result —
    // wait until the draft actually travels with the response.
    if (job.status === "failed" || (job.status === "completed" && job.draft)) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("import job did not finish");
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

  it("runs B's job core into a contract-valid draft with conflict + AI entries", async () => {
    const job = await runImportToDone();
    expect(job.status).toBe("completed");
    expect(job.error).toBeUndefined();

    const draft = job.draft!;
    expect(draft.title).toBe("雾港旧事");
    const names = draft.entries.map((e) => e.name);
    expect(names).toContain("林一舟");
    expect(names).toContain("雾港务局");
    expect(names).toContain("陈半潮");
    expect(names).toContain("观潮石");

    // Conflicting claims across chunks → machine conflict fingerprint.
    const conflict = draft.entries.find((e) => e.provenanceStatus === "conflict");
    expect(conflict?.name).toBe("大雾封港规程");
    expect(typeof conflict?.conflictNotes).toBe("string");

    // Pure AI inference without paragraphs stays ai-inferred, undecided.
    const inferred = draft.entries.find(
      (e) => e.provenanceStatus === "ai-inferred",
    );
    expect(inferred).toBeDefined();
    expect(inferred?.aiAccepted).toBeUndefined();
  });

  it("404s for an unknown job id and resumes idempotently when done", async () => {
    expect(
      (await app.request("/api/world-import/jobs/nope")).status,
    ).toBe(404);

    const job = await runImportToDone();
    const res = await app.request(`/api/world-import/jobs/${job.jobId}/resume`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const resumed = (await res.json()) as JobView;
    expect(resumed.status).toBe("completed");
    expect(resumed.draft).toBeDefined();
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

  it("409s while the canonical draft still has an unresolved conflict", async () => {
    const job = await runImportToDone();
    const res = await app.request("/api/world-import/export", {
      method: "POST",
      body: JSON.stringify({ draft: job.draft }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(409);
  });

  it("approved draft → no error provenance markers → loader accepts → world upserted", async () => {
    const job = await runImportToDone();
    const raw = job.draft!;
    const conflict = raw.entries.find((e) => e.provenanceStatus === "conflict")!;
    const inferred = raw.entries.find(
      (e) => e.provenanceStatus === "ai-inferred",
    )!;

    // Owner review decisions through the canonical contract helpers.
    let approved = loadDraft(JSON.stringify(raw));
    approved = markAiAccepted(approved, inferred.id);
    approved = markConflictResolved(approved, conflict.id);

    const res = await app.request("/api/world-import/export", {
      method: "POST",
      body: JSON.stringify({ draft: approved }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      world: { id: string; name: string };
      worldDirName: string;
      summary: { files: string[] };
    };
    expect(body.world.id).toBe(approved.id);
    expect(body.world.name).toBe("雾港旧事");
    expect(body.summary.files).toContain("data/lorebook.yaml");

    // The accepted/resolved entries must NOT carry error provenance markers.
    const lorebook = await readFile(
      path.join(worldsRoot, body.worldDirName, "data", "lorebook.yaml"),
      "utf-8",
    );
    expect(lorebook).not.toContain("[推断]");
    expect(lorebook).not.toContain("[冲突待解]");

    // …and the world passed Covel's own loader into the store.
    const stored = await store.getWorld(approved.id);
    expect(stored).not.toBeNull();
    expect(stored?.name).toBe("雾港旧事");
  });

  it("undecided entries keep their provenance markers", async () => {
    // Approve a draft where the AI entry was NOT accepted: the [推断]
    // marker must survive so undecided content stays visibly provisional.
    const job = await runImportToDone();
    const raw = job.draft!;
    const conflict = raw.entries.find((e) => e.provenanceStatus === "conflict")!;
    const approved = markConflictResolved(loadDraft(JSON.stringify(raw)), conflict.id);

    const res = await app.request("/api/world-import/export", {
      method: "POST",
      body: JSON.stringify({ draft: approved }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { worldDirName: string };
    const lorebook = await readFile(
      path.join(worldsRoot, body.worldDirName, "data", "lorebook.yaml"),
      "utf-8",
    );
    expect(lorebook).toContain("[推断]");
    expect(lorebook).not.toContain("[冲突待解]");
  });
});
