import { describe, expect, it, vi } from "vitest";

import { callInfrakineticManagementApi } from "../../src/management/managementApiClient.js";

describe("management/managementApiClient", () => {
  it("attaches the assertion as a Bearer token and calls the exact URL/method", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ ok: true }),
    });

    const result = await callInfrakineticManagementApi({
      baseUrl: "https://infrakinetic.test.invalid",
      path: "/management/v1/engines/catalog",
      assertion: "signed.jwt.value",
      correlationId: "corr-1",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://infrakinetic.test.invalid/management/v1/engines/catalog");
    expect(options.method).toBe("GET");
    expect(options.headers.authorization).toBe("Bearer signed.jwt.value");
    expect(result).toEqual({ status: 200, body: { ok: true } });
  });

  it("never includes anything resembling private key material in the outbound request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, json: async () => ({}) });
    await callInfrakineticManagementApi({
      baseUrl: "https://infrakinetic.test.invalid",
      path: "/management/v1/engines/catalog",
      assertion: "signed.jwt.value",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const serializedCall = JSON.stringify(fetchImpl.mock.calls[0]);
    expect(serializedCall).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
  });
});
