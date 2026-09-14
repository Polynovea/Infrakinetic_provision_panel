export interface BrowserCookieNames {
  oauth: string;
  session: string;
}

export function browserCookieNames(secure: boolean): BrowserCookieNames {
  const prefix = secure ? "__Host-" : "";
  return {
    oauth: `${prefix}governance_oauth`,
    session: `${prefix}governance_session`,
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
