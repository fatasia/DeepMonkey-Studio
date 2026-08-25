import { describe, expect, it, vi } from "vitest";
import { BrowserHostAdapter } from "./browserHostAdapter.js";

const AUTH_TOKEN_KEY = "bim-studio-auth-token";

describe("BrowserHostAdapter", () => {
  it("prefers a persistent token when both stores contain one", () => {
    const browserWindow = createBrowserWindow();
    browserWindow.localStorage.setItem(AUTH_TOKEN_KEY, "persistent");
    browserWindow.sessionStorage.setItem(AUTH_TOKEN_KEY, "session");

    expect(new BrowserHostAdapter(browserWindow).getAccessToken()).toBe("persistent");
  });

  it.each([
    [true, "localStorage", "sessionStorage"],
    [false, "sessionStorage", "localStorage"]
  ] as const)("stores persistent=%s tokens exclusively in %s", (persistent, selected, other) => {
    const browserWindow = createBrowserWindow();
    const adapter = new BrowserHostAdapter(browserWindow);
    browserWindow.localStorage.setItem(AUTH_TOKEN_KEY, "old-local");
    browserWindow.sessionStorage.setItem(AUTH_TOKEN_KEY, "old-session");

    adapter.setAccessToken("next", persistent);

    expect(browserWindow[selected].getItem(AUTH_TOKEN_KEY)).toBe("next");
    expect(browserWindow[other].getItem(AUTH_TOKEN_KEY)).toBeNull();
  });

  it("clears both token stores", () => {
    const browserWindow = createBrowserWindow();
    browserWindow.localStorage.setItem(AUTH_TOKEN_KEY, "persistent");
    browserWindow.sessionStorage.setItem(AUTH_TOKEN_KEY, "session");

    new BrowserHostAdapter(browserWindow).clearAccessToken();

    expect(browserWindow.localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
    expect(browserWindow.sessionStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
  });

  it("provides a same-origin server profile", () => {
    const adapter = new BrowserHostAdapter(createBrowserWindow("https://bim.example.test"));

    expect(adapter.getServerProfile()).toEqual({ baseUrl: "https://bim.example.test" });
  });

  it("dispatches the auth-required event", () => {
    const browserWindow = createBrowserWindow();
    const listener = vi.fn();
    browserWindow.addEventListener("bim-studio-auth-required", listener);

    new BrowserHostAdapter(browserWindow).notifyUnauthorized();

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

function createBrowserWindow(origin = "https://example.test"): Window {
  const eventTarget = new EventTarget();
  return Object.assign(eventTarget, {
    location: { origin },
    localStorage: createStorage(),
    sessionStorage: createStorage()
  }) as unknown as Window;
}

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); }
  };
}
