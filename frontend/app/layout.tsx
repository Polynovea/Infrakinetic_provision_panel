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
      <body>
        <OperatorSessionProvider>{children}</OperatorSessionProvider>
      </body>
    </html>
  );
}
