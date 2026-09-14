"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { useOperatorSession } from "../lib/session";

const NAV_ITEMS = [
  { href: "/", label: "Overview" },
  { href: "/tenants", label: "Tenants" },
  { href: "/engine-state", label: "Platform" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { operator, signOut } = useOperatorSession();

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">PolyNovea Governance</div>
        <nav className="app-nav">
          {NAV_ITEMS.map((item) => (
            <a key={item.href} href={item.href} className={`app-nav-link${pathname === item.href ? " active" : ""}`}>
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          {operator && <span className="app-operator">{operator.email}</span>}
          <button className="btn" onClick={() => void signOut()}>
            Sign out
          </button>
        </header>
        <div className="app-content">{children}</div>
      </div>
    </div>
  );
}
