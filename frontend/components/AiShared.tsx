"use client";

// Phase 1A.15 Slice 1 — shared rendering for AI owner state. The owner
// contract marks anything a later slice will model as
// { notModelled: true, slice }; the UI must show that honestly rather than
// as zero or "healthy" (master plan §61: unknown is not green).

export interface NotModelled {
  notModelled: true;
  slice: number;
  note?: string;
}

export interface AiEnforcementFacts {
  platformEngineStateEnforcedOnExecution: boolean;
  quotaConcurrencySafe: boolean;
  usageAttributionComplete: boolean;
  fingerprintSecretPosture: "configured" | "migration_env_only" | "dev_fallback" | "missing";
}

export function isNotModelled(value: unknown): value is NotModelled {
  return Boolean(value && typeof value === "object" && (value as { notModelled?: unknown }).notModelled === true);
}

export function NotModelledNote({ value }: { value: NotModelled }) {
  return (
    <span className="overlay-note" style={{ marginTop: 0 }} title={value.note}>
      Not modelled yet (1A.15 Slice {value.slice})
    </span>
  );
}

export const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export const fmtNumber = (n: number) => n.toLocaleString();
export const fmtCost = (n: number, currency: string | null = "USD") => `${n.toFixed(4)} ${currency ?? ""}`.trim();

const GAP_LABELS: Array<[keyof AiEnforcementFacts, string]> = [
  ["platformEngineStateEnforcedOnExecution", "A platform-level module_ai disable does not stop AI execution (D2)."],
  ["quotaConcurrencySafe", "Hard quotas can be overshot by concurrent requests (D8)."],
  ["usageAttributionComplete", "Denials and lost metering rows are not yet recorded (D1/D7, Slice 3)."],
];

// Known runtime gaps the owner itself reports. Shown whenever present so an
// operator never reads a value as stronger than the runtime guarantees.
export function EnforcementGaps({ facts }: { facts: AiEnforcementFacts }) {
  const gaps = GAP_LABELS.filter(([k]) => facts[k] === false).map(([, label]) => label);
  const posture = facts.fingerprintSecretPosture;
  if (posture === "missing") gaps.push("AI metering secret is not configured — AI provider calls are refused (D15).");
  if (posture === "dev_fallback") gaps.push("AI metering is using the development fingerprint key (non-production host).");
  if (posture === "migration_env_only") gaps.push("Provider key fingerprints use the legacy Migration-named secret — migrate to AI_METERING_FINGERPRINT_SECRET (D15).");
  if (gaps.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: "1rem", fontSize: "0.85rem", borderColor: "var(--warning-fg)" }}>
      <strong>Known enforcement gaps reported by module_ai</strong>
      <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.2rem" }}>
        {gaps.map((g) => <li key={g}>{g}</li>)}
      </ul>
    </div>
  );
}

export const MISMATCH_LABELS: Record<string, string> = {
  module_ai_not_entitled: "module_ai not entitled",
  capability_disabled_globally: "Capability disabled globally",
  plane_not_allowed: "Plane not allowed by capability",
  no_call_site_binding: "No call site",
  feature_flag_disabled: "Tenant feature flag off",
  permission_missing: "Required permission missing",
  provider_disabled: "Provider not active",
  model_not_active: "Model not active",
  model_class_not_allowed: "Model class not allowed",
  no_adapter: "No provider adapter",
  legacy_kill_switch_disabled: "Legacy kill switch off",
  no_capability_for_plane: "No capability on this plane",
  no_effective_capability: "No effective capability",
  no_feature_binding: "Capability declares no feature gate",
  platform_engine_disabled: "module_ai disabled platform-wide",
  emergency_suspended: "Tenant AI emergency-suspended",
  plane_not_allowed_by_root: "Plane not allowed by root policy",
  capability_not_commissioned: "Not commissioned",
  model_denied_for_tenant: "Model denied for tenant",
};
