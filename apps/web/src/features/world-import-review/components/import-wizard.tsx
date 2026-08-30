import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Loader2, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { inputCls } from "@/components/world/editor-helpers.js";
import { cn } from "@/lib/utils.js";
import {
  getWorldImportJob,
  startWorldImport,
  type ImportJobView,
} from "@/services/api/world-import.js";
import { parseDraft, type WorldImportDraft } from "../model.js";

/**
 * The real intake path: pick TXT / MD / EPUB sources, name the world,
 * watch the pipeline job, land in Review when the draft is ready.
 */

const POLL_INTERVAL_MS = 400;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ImportWizardProps {
  onImported: (draft: WorldImportDraft) => void;
}

export function ImportWizard({ onImported }: ImportWizardProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const adoptedRef = useRef(false);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await getWorldImportJob(jobId);
        if (stopped) return;
        setJob(next);
        if (next.status === "failed") {
          setError(next.error ?? t("worldImport.wizard.failed"));
          return;
        }
        if (next.status !== "completed" || next.draft === undefined) return;
        // Hand the contract-validated completed draft to Review once.
        if (!adoptedRef.current) {
          const parsed = parseDraft(next.draft);
          if (!parsed.ok) {
            setError(parsed.error);
            return;
          }
          adoptedRef.current = true;
          onImported(parsed.draft);
        }
      } catch (err) {
        if (stopped) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [jobId, onImported, t]);

  const start = async () => {
    setError(null);
    if (title.trim().length === 0) {
      setError(t("worldImport.wizard.needTitle"));
      return;
    }
    if (files.length === 0) {
      setError(t("worldImport.wizard.needFiles"));
      return;
    }
    try {
      const { jobId: newJobId } = await startWorldImport(title.trim(), files);
      setJobId(newJobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const running =
    job !== null && job.status !== "completed" && job.status !== "failed";

  return (
    <div className="max-w-2xl mx-auto w-full">
      <div className="border border-border/70 rounded-(--radius-control) p-5 md:p-6">
        <h2 className="text-lg font-semibold">
          {t("worldImport.wizard.title")}
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">
          {t("worldImport.wizard.desc")}
        </p>

        <div className="mt-5 flex flex-col gap-4">
          <div>
            <label className="ui-eyebrow block mb-1.5 text-muted-foreground">
              {t("worldImport.wizard.titleLabel")}
            </label>
            <input
              className={inputCls}
              value={title}
              placeholder={t("worldImport.wizard.titlePlaceholder")}
              aria-label={t("worldImport.wizard.titleLabel")}
              disabled={running}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div>
            <label className="ui-eyebrow block mb-1.5 text-muted-foreground">
              {t("worldImport.wizard.fileLabel")}
            </label>
            <label
              className={cn(
                "flex items-center justify-center gap-2 border border-dashed border-border/70 rounded-(--radius-control) px-4 py-6 text-sm text-muted-foreground cursor-pointer transition-colors hover:text-foreground hover:bg-muted/40",
                running && "pointer-events-none opacity-60",
              )}
            >
              <FileText className="h-4 w-4" aria-hidden />
              {t("worldImport.wizard.fileButton")}
              <input
                type="file"
                multiple
                accept=".txt,.md,.epub"
                className="sr-only"
                aria-label={t("worldImport.wizard.fileLabel")}
                disabled={running}
                onChange={(event) => {
                  const selected = Array.from(event.target.files ?? []);
                  if (selected.length > 0) setFiles(selected);
                }}
              />
            </label>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("worldImport.wizard.fileHint")}
            </p>
            {files.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {files.map((file) => (
                  <li
                    key={file.name}
                    className="flex items-center justify-between gap-2 text-xs border border-border/70 rounded-(--radius-control) px-2.5 py-1.5"
                  >
                    <span className="truncate">
                      {file.name}
                      <span className="ml-2 text-muted-foreground">
                        {formatBytes(file.size)}
                      </span>
                    </span>
                    {!running && (
                      <button
                        type="button"
                        aria-label={t("worldImport.wizard.removeFile", {
                          name: file.name,
                        })}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          setFiles((prev) => prev.filter((f) => f !== file))
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {running && job && (
            <div
              className="flex items-center gap-3 border border-border/70 rounded-(--radius-control) px-3 py-3"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden />
              <div className="text-sm">
                {job.stage === "queued"
                  ? t("worldImport.progress.parsing")
                  : t("worldImport.progress.extracting", {
                      done: job.processedChunks,
                      total: Math.max(job.chunksTotal, job.processedChunks),
                    })}
              </div>
              {job.stage !== "queued" && job.chunksTotal > 0 && (
                <div className="ml-auto flex items-center gap-2 min-w-24">
                  <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-(--accent-primary) rounded-full transition-all"
                      style={{
                        width: `${Math.min(100, Math.round((job.processedChunks / Math.max(job.chunksTotal, 1)) * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {job?.status === "completed" && !error && (
            <p className="text-sm text-primary" role="status">
              {t("worldImport.progress.done")}
            </p>
          )}

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              disabled={running}
              onClick={() => void start()}
            >
              <Play className="h-3.5 w-3.5" />
              {t("worldImport.wizard.start")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("worldImport.wizard.modelHint")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
