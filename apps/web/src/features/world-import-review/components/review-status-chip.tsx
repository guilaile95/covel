import { CheckCircle2, CircleDashed, PencilLine, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils.js";
import type { EntryReviewStatus } from "../model.js";

/**
 * The owner-facing completion state of one entry: what (if anything) still
 * needs their attention. Derived from the contract fields + review
 * decisions — never stored separately.
 */

const STATUS_CONFIG: Record<
  EntryReviewStatus,
  { icon: typeof PencilLine; className: string }
> = {
  unreviewed: {
    icon: CircleDashed,
    className: "text-muted-foreground",
  },
  edited: {
    icon: PencilLine,
    className: "text-primary",
  },
  "ai-accepted": {
    icon: Sparkles,
    className: "text-primary",
  },
  "conflict-resolved": {
    icon: CheckCircle2,
    className: "text-primary",
  },
};

const STATUS_KEY: Record<EntryReviewStatus, string> = {
  unreviewed: "worldImport.entryStatus.unreviewed",
  edited: "worldImport.entryStatus.edited",
  "ai-accepted": "worldImport.entryStatus.aiAccepted",
  "conflict-resolved": "worldImport.entryStatus.conflictResolved",
};

export function ReviewStatusChip({
  status,
  className,
}: {
  status: EntryReviewStatus;
  className?: string;
}) {
  const { t } = useTranslation();
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11px] font-medium",
        config.className,
        className,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {t(STATUS_KEY[status])}
    </span>
  );
}
