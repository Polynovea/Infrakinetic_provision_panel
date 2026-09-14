const TONE_BY_VALUE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  operational: "success",
  active: "success",
  degraded: "warning",
  trial: "warning",
  disabled: "danger",
  suspended: "danger",
  cancelled: "danger",
  platform: "neutral",
  customer: "neutral",
};

export function StatusBadge({ value }: { value: string }) {
  const tone = TONE_BY_VALUE[value.toLowerCase()] ?? "neutral";
  return <span className={`badge badge-${tone}`}>{value}</span>;
}
