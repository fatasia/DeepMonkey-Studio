import { describe, expect, it, vi } from "vitest";
import { createAuthenticationRecheck } from "./authenticationRecheck";

function fixture() {
  let token: string | undefined = "isolated-fixture-token";
  const notifyUnauthorized = vi.fn();
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
  const schedule = createAuthenticationRecheck({ getAccessToken: () => token, getServerProfile: () => ({ baseUrl: "https://fixture.invalid" }), notifyUnauthorized }, transport);
  return { transport, schedule, notifyUnauthorized, setToken: (value?: string) => { token = value; } };
}

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("authentication recheck scheduling", () => {
  it("deduplicates simultaneous business 401 and permits a later recheck", async () => {
    const f = fixture();
    f.schedule(); f.schedule(); await flush();
    expect(f.transport).toHaveBeenCalledOnce();
    expect(f.transport).toHaveBeenCalledWith(new URL("https://fixture.invalid/api/auth/me"), {
      headers: { authorization: "Bearer isolated-fixture-token" }, cache: "no-store",
    });
    expect(f.notifyUnauthorized).not.toHaveBeenCalled();
    f.schedule(); await flush(); expect(f.transport).toHaveBeenCalledTimes(2);
  });

  it("only expires the same token on an explicit second 401", async () => {
    const f = fixture();
    f.transport.mockResolvedValue(new Response(null, { status: 401 }));
    f.schedule(); await flush(); expect(f.notifyUnauthorized).toHaveBeenCalledOnce();
  });

  it.each([403, 500, 502, 503, 504])("retains the session when recheck returns %i", async status => {
    const f = fixture();
    f.transport.mockResolvedValue(new Response(null, { status }));
    f.schedule(); await flush(); expect(f.notifyUnauthorized).not.toHaveBeenCalled();
  });

  it("retains credentials on a network failure and releases the pending guard", async () => {
    const f = fixture(); f.transport.mockRejectedValueOnce(new TypeError("offline"));
    f.schedule(); await flush(); expect(f.notifyUnauthorized).not.toHaveBeenCalled();
    f.schedule(); await flush(); expect(f.transport).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "new-fixture-token"])("ignores a stale response after logout or identity change (%s)", async token => {
    const f = fixture();
    let release!: (response: Response) => void;
    f.transport.mockReturnValue(new Promise(resolve => { release = resolve; }));
    f.schedule(); await flush(); f.setToken(token);
    release(new Response(null, { status: 401 })); await flush();
    expect(f.notifyUnauthorized).not.toHaveBeenCalled();
  });

  it("does not request a session endpoint without credentials", async () => {
    const f = fixture(); f.setToken(); f.schedule(); await flush();
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(["sync", "async"])("contains %s credential adapter failures and releases the pending guard", async mode => {
    const getAccessToken = vi.fn<() => string | Promise<string>>().mockReturnValue("fixture-token");
    getAccessToken.mockImplementationOnce(() => {
      if (mode === "sync") throw new Error("credential adapter unavailable");
      return Promise.reject(new Error("credential adapter unavailable"));
    });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const notifyUnauthorized = vi.fn();
    const schedule = createAuthenticationRecheck({ getAccessToken, getServerProfile: () => ({ baseUrl: "https://fixture.invalid" }), notifyUnauthorized }, transport);
    expect(() => schedule()).not.toThrow(); await flush();
    expect(transport).not.toHaveBeenCalled();
    expect(notifyUnauthorized).not.toHaveBeenCalled();
    schedule(); await flush();
    expect(transport).toHaveBeenCalledOnce();
  });
});
