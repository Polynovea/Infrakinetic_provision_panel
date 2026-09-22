// "unknown" reads as warning, not neutral — master plan §61: "unknown is
// not green." A stale/failed read should never look as safe as a real
// success state.
const TONE_BY_VALUE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  operational: "success",
  active: "success",
  completed: "success",
  degraded: "warning",
  trial: "warning",
  partially_completed: "warning",
  compensating: "warning",
  unknown: "warning",
  disabled: "danger",
  suspended: "danger",
  cancelled: "danger",
  decommissioned: "danger",
  failed: "danger",
  platform: "neutral",
  customer: "neutral",
  submitted: "neutral",
  accepted: "neutral",
  running: "neutral",
  // 1A.12 identity administration.
  invited: "warning",
  inactive: "danger",
  pending: "warning",
  sent: "neutral",
  approved: "success",
  rejected: "danger",
  expired: "danger",
  confirmed: "success",
  reset_required: "warning",
  force_change_password: "warning",
};

const LABEL_BY_VALUE: Record<string, string> = {
  partially_completed: "Partially completed",
};

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const tone = TONE_BY_VALUE[normalized] ?? "neutral";
  const label = LABEL_BY_VALUE[normalized] ?? value.replace(/_/g, " ");
  return <span className={`badge badge-${tone}`}>{label}</span>;
}
