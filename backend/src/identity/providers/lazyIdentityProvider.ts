import type { IdentityProvider, VerifiedTokenClaims } from "../identityProvider.js";

// Defers construction of the wrapped provider until the first token
// verification, so server startup (and /healthz) never depends on Cognito
// configuration being present — only an actual request under
// /management/v1/* does. Matches the 1A.1 invariant that /healthz passes
// with zero external dependencies, now extended to "server boot never
// requires Cognito to exist yet" while Cognito provisioning is pending.
export class LazyIdentityProvider implements IdentityProvider {
  private instance: IdentityProvider | undefined;

  constructor(private readonly factory: () => IdentityProvider) {}

  async verifyToken(rawToken: string): Promise<VerifiedTokenClaims> {
    if (!this.instance) {
      this.instance = this.factory();
    }
    return this.instance.verifyToken(rawToken);
  }
}
