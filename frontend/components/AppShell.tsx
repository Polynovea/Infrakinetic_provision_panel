"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { useOperatorSession } from "../lib/session";
import { Icon } from "./Icon";

const NAV_GROUPS = [
  {
    label: "Fleet",
    items: [
      { href: "/", label: "Overview", icon: "space_dashboard" },
      { href: "/tenants", label: "Tenants", icon: "domain" },
      { href: "/ai", label: "AI operations", icon: "smart_toy" },
    ],
  },
  {
    label: "Operations",
    items: [
      { href: "/reconciliation", label: "Tenant health", icon: "fact_check" },
      { href: "/approvals", label: "Approvals", icon: "approval" },
      { href: "/infrastructure", label: "Infrastructure", icon: "cloud" },
      { href: "/finops", label: "FinOps", icon: "monitoring" },
    ],
  },
  {
    label: "Advanced controls",
    items: [
      { href: "/engine-state", label: "Engine controls", icon: "dns" },
      { href: "/payment-adapters", label: "Payment extensions", icon: "payments" },
      { href: "/global-config", label: "Configuration restore", icon: "settings_backup_restore" },
    ],
  },
] as const;

const PAGE_TITLES: Record<string, string> = {
  "/": "Overview",
  "/tenants": "Tenants",
  "/ai": "AI operations",
  "/reconciliation": "Tenant health",
  "/approvals": "Approvals",
  "/infrastructure": "Infrastructure",
  "/finops": "FinOps",
  "/engine-state": "Engine controls",
  "/payment-adapters": "Payment extensions",
  "/global-config": "Configuration restore",
};

function operatorRoleLabel(roles: readonly string[]): string {
  if (roles.length === 0) return "Operator";
  return roles[0]
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { operator, signOut } = useOperatorSession();
  const pageTitle = PAGE_TITLES[pathname] ?? "Platform Governance";

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">
          <div className="app-brand-name">PolyNovea</div>
          <div className="app-brand-tagline">Platform Governance</div>
        </div>

        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="app-nav-section-label">{group.label}</div>
            <nav className="app-nav" aria-label={group.label}>
              {group.items.map((item) => {
                const active = pathname === item.href;
                return (
                  <a key={item.href} href={item.href} className={`app-nav-link${active ? " active" : ""}`}>
                    <Icon name={item.icon} filled={active} />
                    {item.label}
                  </a>
                );
              })}
            </nav>
          </div>
        ))}

        <div className="app-sidebar-spacer" />

        {operator && (
          <div className="app-identity-card">
            <div className="app-identity-email">{operator.email}</div>
            <div className="app-identity-role">{operatorRoleLabel(operator.roles)}</div>
          </div>
        )}
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          <div className="app-topbar-title">{pageTitle}</div>
          <button className="btn" onClick={() => void signOut()} aria-label="Sign out" style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
            <Icon name="logout" size="sm" /> Sign out
          </button>
        </header>
        <div className="app-content">{children}</div>
      </div>
    </div>
  );
}
