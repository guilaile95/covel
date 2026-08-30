import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckCircle2,
  Download,
  Loader2,
  RotateCcw,
  Save,
  Stamp,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import { useSession } from "@/stores/session-store.js";
import { getWorld } from "@/services/api/worlds.js";
import { exportApprovedWorld } from "@/services/api/world-import.js";
import {
  findEntry,
  reviewCounts,
  type EntryType,
  type StatusFilter,
} from "../model.js";
import { downloadWorldImportDraft } from "../draft-service.js";
import { WorldImportDraftStore } from "../draft-store.js";
import type { DraftReview } from "../use-draft-review.js";
import { useDraftReview } from "../use-draft-review.js";
import { EntryDetailPanel } from "./entry-detail-panel.js";
import { EntryListPanel } from "./entry-list-panel.js";
import { ImportWizard } from "./import-wizard.js";
import { ProvenanceBadge } from "./provenance-badge.js";

/**
 * World Import page — route /world-import-review.
 *
 * Phases: no draft yet → import wizard (pick TXT/MD/EPUB → pipeline job →
 * progress); draft ready → the review workbench; after approval → success
 * banner handing over to the existing world-start path.
 */

type ApproveState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "success"; worldId: string; worldName: string }
  | { phase: "error"; message: string };

function StatChip({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: "destructive" | "primary";
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span
        className={
          emphasis === "destructive"
            ? "text-lg font-semibold text-destructive tabular-nums"
            : emphasis === "primary"
              ? "text-lg font-semibold text-primary tabular-nums"
              : "text-lg font-semibold tabular-nums"
        }
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function LoadingView({ label }: { label: string }) {
  return (
    <div className="h-full flex items-center justify-center">
      <p className="text-sm text-muted-foreground animate-pulse">{label}</p>
    </div>
  );
}

function Workbench({ review }: { review: DraftReview }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { addWorldLocal } = useSession();
  const [activeType, setActiveType] = useState<EntryType | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [approve, setApprove] = useState<ApproveState>({ phase: "idle" });

  const draft = review.draft;
  if (!draft) return null;
  const counts = reviewCounts(draft, review.decisions);
  const selectedEntry = findEntry(draft, selectedEntryId);

  const handleDiscard = async () => {
    const approved = await requestConfirm({
      title: t("worldImport.discard.confirmTitle"),
      message: t("worldImport.discard.confirmMessage"),
      confirmLabel: t("worldImport.discard.action"),
      cancelLabel: t("common.cancel"),
    });
    if (!approved) return;
    setSelectedEntryId(null);
    setApprove({ phase: "idle" });
    await review.discard();
  };

  const handleApprove = async () => {
    if (counts.unresolvedConflicts > 0) return;
    setApprove({ phase: "running" });
    try {
      const result = await exportApprovedWorld(
        draft,
        review.decisions.resolvedConflicts,
      );
      setApprove({
        phase: "success",
        worldId: result.world.id,
        worldName: result.world.name,
      });
    } catch (error) {
      setApprove({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleStartGame = async (worldId: string) => {
    // Existing world-start path: pull the freshly generated world into the
    // session store's world list (same ingestion as AI world creation) and
    // hand over to the world-select → prep → start flow. No runtime code.
    try {
      const record = await getWorld(worldId);
      addWorldLocal(record);
    } catch {
      // The world list will still pick it up on the next boot; navigating
      // is strictly better than blocking on a refresh failure.
    }
    await navigate({ to: "/session", search: {} });
  };

  return (
    <div className="w-full">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-10 py-5 md:py-8">
        <header className="mb-6">
          <p className="ui-eyebrow text-muted-foreground mb-2">
            {t("worldImport.eyebrow")}
          </p>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-display font-bold tracking-tight text-2xl md:text-3xl leading-tight">
                {draft.title}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground font-mono">
                {draft.id} ·{" "}
                {t("worldImport.metaVersion", {
                  version: String(draft.version),
                })}
              </p>
            </div>
            <div className="flex items-center flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!review.dirty || review.saving}
                onClick={() => void review.save()}
              >
                <Save className="h-3.5 w-3.5" />
                {t("worldImport.action.save")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => downloadWorldImportDraft(draft)}
              >
                <Download className="h-3.5 w-3.5" />
                {t("worldImport.action.export")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={review.discarding}
                onClick={() => void handleDiscard()}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("worldImport.discard.action")}
              </Button>
            </div>
          </div>

          <p className="mt-3 max-w-3xl text-sm text-muted-foreground leading-relaxed">
            {draft.summary}
          </p>

          <div className="mt-3 flex items-center flex-wrap gap-x-4 gap-y-1.5">
            {draft.sources.map((source) => (
              <span
                key={source.id}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground border border-border/70 rounded-(--radius-control) px-2 py-0.5"
              >
                <span
                  className="h-1.5 w-1.5 rounded-full bg-(--accent-primary)"
                  aria-hidden
                />
                {source.file}
              </span>
            ))}
            <span className="text-xs text-muted-foreground">
              {review.savedAt
                ? t("worldImport.savedAt", {
                    time: new Date(review.savedAt).toLocaleString(),
                  })
                : t("worldImport.notSavedYet")}
            </span>
            {review.dirty && (
              <span className="text-xs font-medium text-primary">
                {t("worldImport.unsaved")}
              </span>
            )}
          </div>
        </header>

        <section className="flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-border/70 py-3 mb-6">
          <StatChip label={t("worldImport.stats.total")} value={counts.total} />
          <StatChip
            label={t("worldImport.stats.sourceBacked")}
            value={counts.sourceBacked}
          />
          <StatChip
            label={t("worldImport.stats.aiInferred")}
            value={counts.aiInferred}
          />
          <StatChip
            label={t("worldImport.stats.conflict")}
            value={counts.conflict}
            emphasis={
              counts.unresolvedConflicts > 0 ? "destructive" : undefined
            }
          />
          <StatChip
            label={t("worldImport.stats.userEdited")}
            value={counts.userEdited}
          />
          <StatChip
            label={t("worldImport.stats.pending")}
            value={counts.pending}
            emphasis={counts.pending > 0 ? "primary" : undefined}
          />
          {counts.unresolvedConflicts > 0 && (
            <>
              <ProvenanceBadge status="conflict" />
              <span className="text-xs text-destructive">
                {t("worldImport.export.conflictWarning", {
                  count: counts.unresolvedConflicts,
                })}
              </span>
            </>
          )}
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 lg:sticky lg:top-4">
            <EntryListPanel
              draft={draft}
              decisions={review.decisions}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              activeType={activeType}
              onTypeChange={setActiveType}
              selectedEntryId={selectedEntryId}
              onSelectEntry={setSelectedEntryId}
            />
          </div>
          <div className="lg:col-span-7 flex flex-col gap-6">
            <EntryDetailPanel
              draft={draft}
              entry={selectedEntry}
              decisions={review.decisions}
              onEdit={review.editEntry}
              onAcceptAi={review.acceptAi}
              onRemoveEntry={(entryId) => {
                review.removeEntry(entryId);
                if (entryId === selectedEntryId) setSelectedEntryId(null);
              }}
              onResolveConflict={review.resolveConflict}
            />

            <section className="border border-border/70 rounded-(--radius-control) p-4">
              <h3 className="ui-eyebrow mb-2 text-muted-foreground">
                {t("worldImport.approve.title")}
              </h3>
              {approve.phase === "success" ? (
                <div className="flex flex-col gap-2">
                  <p className="inline-flex items-center gap-2 text-sm font-medium text-primary">
                    <CheckCircle2 className="h-4 w-4" aria-hidden />
                    {t("worldImport.approve.successTitle")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("worldImport.approve.successBody", {
                      name: approve.worldName,
                    })}
                  </p>
                  <div>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void handleStartGame(approve.worldId)}
                    >
                      {t("worldImport.approve.startGame")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center flex-wrap gap-3">
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        counts.unresolvedConflicts > 0 ||
                        approve.phase === "running"
                      }
                      onClick={() => void handleApprove()}
                    >
                      {approve.phase === "running" ? (
                        <Loader2
                          className="h-3.5 w-3.5 animate-spin"
                          aria-hidden
                        />
                      ) : (
                        <Stamp className="h-3.5 w-3.5" />
                      )}
                      {t("worldImport.approve.action")}
                    </Button>
                    {counts.unresolvedConflicts > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {t("worldImport.approve.blockedHint", {
                          count: counts.unresolvedConflicts,
                        })}
                      </span>
                    )}
                  </div>
                  {approve.phase === "error" && (
                    <p
                      className="text-sm text-destructive wrap-break-word"
                      role="alert"
                    >
                      {t("worldImport.approve.failedTitle")}: {approve.message}
                    </p>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ReviewPage({ store }: { store?: WorldImportDraftStore }) {
  const { t } = useTranslation();
  const review = useDraftReview(store);

  if (review.loadState.status === "loading") {
    return <LoadingView label={t("worldImport.status.loading")} />;
  }
  if (review.loadState.status === "empty") {
    return (
      <div className="h-full w-full overflow-y-auto overscroll-contain">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 md:px-10 py-8">
          <p className="ui-eyebrow text-muted-foreground mb-4">
            {t("worldImport.eyebrow")}
          </p>
          <ImportWizard
            onImported={(imported) => void review.adopt(imported)}
          />
        </div>
      </div>
    );
  }
  if (review.loadState.status === "error") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-destructive wrap-break-word max-w-xl">
          {review.loadState.message}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void review.discardCorrupted()}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("worldImport.status.resetLocal")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => window.location.reload()}
          >
            {t("worldImport.status.retry")}
          </Button>
        </div>
      </div>
    );
  }
  return <Workbench review={review} />;
}
