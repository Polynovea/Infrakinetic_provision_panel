import type { CSSProperties } from "react";

// Thin wrapper around a Material Symbols Outlined ligature (loaded in
// app/layout.tsx). `name` is the icon's ligature name, e.g. "dashboard",
// "domain", "tune", "logout" — see https://fonts.google.com/icons for the
// full set. Purely decorative by default (aria-hidden) since every call
// site pairs an icon with adjacent visible text.
export function Icon({
  name,
  filled = false,
  size,
  className = "",
  style,
}: {
  name: string;
  filled?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
  style?: CSSProperties;
}) {
  const sizeClass = size === "sm" ? "icon-sm" : size === "lg" ? "icon-lg" : "";
  const classes = ["icon", sizeClass, filled ? "icon-fill" : "", className].filter(Boolean).join(" ");
  return (
    <span className={classes} style={style} aria-hidden="true">
      {name}
    </span>
  );
}
