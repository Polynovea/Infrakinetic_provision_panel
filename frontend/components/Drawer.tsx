"use client";

import type { ReactNode } from "react";

import { Icon } from "./Icon";

export function Drawer({
  title,
  subtitle,
  onClose,
  children,
  size = "default",
}: {
  title: string;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  size?: "default" | "wide";
}) {
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className={`drawer-panel${size === "wide" ? " drawer-panel-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-header">
          <div>
            <h2 className="text-headline">{title}</h2>
            {subtitle && <div className="overlay-note" style={{ marginTop: "0.35rem" }}>{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size="sm" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </>
  );
}
