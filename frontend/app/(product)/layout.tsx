import type { ReactNode } from "react";

import { AppShell } from "../../components/AppShell";
import { SignInGate } from "../../components/SignInGate";

export default function ProductLayout({ children }: { children: ReactNode }) {
  return (
    <SignInGate>
      <AppShell>{children}</AppShell>
    </SignInGate>
  );
}
