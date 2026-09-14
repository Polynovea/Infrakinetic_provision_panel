export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return <div className="state-panel">{label}</div>;
}

export function EmptyState({ label }: { label: string }) {
  return <div className="state-panel">{label}</div>;
}

export function ErrorState({ label }: { label: string }) {
  return (
    <div className="state-panel error" role="alert">
      {label}
    </div>
  );
}
