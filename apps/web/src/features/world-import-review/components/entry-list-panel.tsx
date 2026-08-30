import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils.js";
import {
  countByType,
  ENTRY_TYPES,
  entryReviewStatus,
  filterEntries,
  type EntryType,
  type StatusFilter,
  type WorldImportDraft,
  type DraftEntry,
} from "../model.js";
import { ProvenanceBadge } from "./provenance-badge.js";
import { ReviewStatusChip } from "./review-status-chip.js";

/**
 * Left pane of the review page: status filter + category filter + the
 * entry list. The list keeps import order; provenance and review-status
 * chips carry the at-a-glance signal.
 */

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1.5 h-7 px-2.5 text-xs rounded-(--radius-control) border transition-colors",
        active
          ? "border-primary/60 bg-primary/10 text-foreground"
          : "border-border/70 text-muted-foreground hover:text-foreground hover:bg-muted/40",
      )}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span className="text-[10px] font-semibold tabular-nums opacity-75">
          {count}
        </span>
      )}
    </button>
  );
}

function EntryListItem({
  entry,
  selected,
  onSelect,
  typeLabel,
}: {
  entry: DraftEntry;
  selected: boolean;
  onSelect: () => void;
  typeLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "w-full text-left border px-3 py-2.5 rounded-(--radius-control) transition-colors",
        selected
          ? "border-primary/60 bg-muted/60"
          : "border-border/70 hover:bg-muted/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-snug">{entry.name}</span>
        <ProvenanceBadge status={entry.provenanceStatus} className="shrink-0" />
      </div>
      {entry.aliases.length > 0 && (
        <div className="mt-0.5 text-xs text-muted-foreground truncate">
          {entry.aliases.join(" · ")}
        </div>
      )}
      <div className="mt-1.5 flex items-center flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span className="border border-border/70 px-1.5 py-px rounded-(--radius-control)">
          {typeLabel}
        </span>
        <ReviewStatusChip status={entryReviewStatus(entry)} />
      </div>
    </button>
  );
}

const STATUS_FILTERS: StatusFilter[] = [
  "all",
  "pending",
  "ai-inferred",
  "conflict",
];

export interface EntryListPanelProps {
  draft: WorldImportDraft;
  statusFilter: StatusFilter;
  onStatusFilterChange: (filter: StatusFilter) => void;
  activeType: EntryType | null;
  onTypeChange: (type: EntryType | null) => void;
  selectedEntryId: string | null;
  onSelectEntry: (entryId: string) => void;
}

export function EntryListPanel({
  draft,
  statusFilter,
  onStatusFilterChange,
  activeType,
  onTypeChange,
  selectedEntryId,
  onSelectEntry,
}: EntryListPanelProps) {
  const { t } = useTranslation();
  const typeCounts = countByType(draft);
  const visibleEntries = filterEntries(draft, {
    type: activeType,
    status: statusFilter,
  });

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {STATUS_FILTERS.map((status) => (
          <FilterChip
            key={status}
            label={t(`worldImport.filter.${status}`)}
            active={statusFilter === status}
            onClick={() => onStatusFilterChange(status)}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        <FilterChip
          label={t("worldImport.category.all")}
          count={draft.entries.length}
          active={activeType === null}
          onClick={() => onTypeChange(null)}
        />
        {(Object.values(ENTRY_TYPES) as EntryType[]).map((type) => (
          <FilterChip
            key={type}
            label={t(`worldImport.category.${type}`)}
            count={typeCounts[type]}
            active={activeType === type}
            onClick={() => onTypeChange(type)}
          />
        ))}
      </div>

      {visibleEntries.length === 0 ? (
        <p className="text-sm text-muted-foreground border border-dashed border-border/70 rounded-(--radius-control) px-3 py-6 text-center">
          {t("worldImport.list.empty")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleEntries.map((entry) => (
            <EntryListItem
              key={entry.id}
              entry={entry}
              selected={entry.id === selectedEntryId}
              onSelect={() => onSelectEntry(entry.id)}
              typeLabel={t(`worldImport.category.${entry.type}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
