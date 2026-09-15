import type { ReactNode } from "react";

import { OperatorSessionProvider } from "../lib/session";
import "./globals.css";

export const metadata = {
  title: "PolyNovea Platform Governance",
  description: "Operator control plane for Infrakinetic.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Same public type/icon system the Infrakinetic product family uses
            (Clash Display via Fontshare, Inter + Material Symbols via Google
            Fonts) — public font links only, no cross-repo code import. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- App Router
            root layout <head> is the documented place for a third-party font
            stylesheet next/font doesn't cover (this rule predates the App
            Router and assumes pages/_document.js, which doesn't exist here). */}
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font, @next/next/google-font-display --
            display=block is Google's own documented recommendation specifically
            for the Material Symbols icon font: swap would flash the raw
            ligature text ("logout", "dns", ...) before the glyph font loads. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block"
          rel="stylesheet"
        />
        <link rel="stylesheet" href="https://api.fontshare.com/v2/css?f[]=clash-display@500,600,700&display=swap" />
      </head>
      <body>
        <OperatorSessionProvider>{children}</OperatorSessionProvider>
      </body>
    </html>
  );
}
