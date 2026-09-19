"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { useOperatorSession } from "../lib/session";
import { Icon } from "./Icon";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: "space_dashboard" },
  { href: "/tenants", label: "Tenants", icon: "domain" },
  { href: "/engine-state", label: "Platform", icon: "dns" },
  { href: "/reconciliation", label: "Reconciliation", icon: "fact_check" },
] as const;

const PAGE_TITLES: Record<string, string> = {
  "/": "Overview",
  "/tenants": "Tenants",
  "/engine-state": "Platform",
  "/reconciliation": "Reconciliation",
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
  const pageTitle = PAGE_TITLES[pathname] ?? "Governance";

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">
          <div className="app-brand-name">PolyNovea</div>
          <div className="app-brand-tagline">Platform Governance</div>
        </div>

        <div className="app-nav-section-label">Fleet</div>
        <nav className="app-nav">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;
            return (
              <a key={item.href} href={item.href} className={`app-nav-link${active ? " active" : ""}`}>
                <Icon name={item.icon} filled={active} />
                {item.label}
              </a>
            );
          })}
        </nav>

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
          <button
            className="icon-btn"
            onClick={() => void signOut()}
            title="Sign out"
            aria-label="Sign out"
          >
            <Icon name="logout" size="sm" />
          </button>
        </header>
        <div className="app-content">{children}</div>
      </div>
    </div>
  );
}
