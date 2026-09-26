export interface BrowserCookieNames {
  oauth: string;
  session: string;
  stepUp: string;
}

export function browserCookieNames(secure: boolean): BrowserCookieNames {
  const prefix = secure ? "__Host-" : "";
  return {
    oauth: `${prefix}governance_oauth`,
    session: `${prefix}governance_session`,
    // Phase 1A.12.4 — distinct from `oauth` so a concurrent ordinary login
    // transaction (a different tab) and a step-up transaction never share
    // one cookie slot.
    stepUp: `${prefix}governance_stepup`,
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

export const SESSION_COOKIE_CANDIDATES = ["__Host-governance_session", "governance_session"] as const;

// Audit remediation L8 — a __Host- cookie cannot be set by a sibling
// subdomain (no Domain attribute, Secure, Path=/), which is the whole point
// of the prefix. Also accepting the unprefixed name in production let a
// cookie planted from any *.parent-domain host stand in for the session
// cookie (session fixation). Production (secure cookies) accepts only the
// __Host- name; local non-TLS development keeps the plain name.
export function sessionCookieCandidates(production: boolean): readonly string[] {
  return production ? ["__Host-governance_session"] : SESSION_COOKIE_CANDIDATES;
}
