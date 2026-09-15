import { Icon } from "./Icon";

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return <div className="state-panel">{label}</div>;
}

export function EmptyState({ label, icon = "inbox" }: { label: string; icon?: string }) {
  return (
    <div className="state-panel">
      <Icon name={icon} size="lg" />
      <div style={{ marginTop: "0.5rem" }}>{label}</div>
    </div>
  );
}

export function ErrorState({ label }: { label: string }) {
  return (
    <div className="state-panel error" role="alert">
      <Icon name="error" size="lg" />
      <div style={{ marginTop: "0.5rem" }}>{label}</div>
    </div>
  );
}
