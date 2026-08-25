import type { AuthStore, ServerProfile } from "@bim-studio/server-sdk";

const AUTH_TOKEN_KEY = "bim-studio-auth-token";

export class BrowserHostAdapter implements AuthStore {
  constructor(private readonly browserWindow: Window) {}

  getServerProfile(): ServerProfile {
    return { baseUrl: this.browserWindow.location.origin };
  }

  getAccessToken(): string {
    return this.browserWindow.localStorage.getItem(AUTH_TOKEN_KEY)
      ?? this.browserWindow.sessionStorage.getItem(AUTH_TOKEN_KEY)
      ?? "";
  }

  setAccessToken(token: string, persistent: boolean): void {
    this.clearAccessToken();
    (persistent ? this.browserWindow.localStorage : this.browserWindow.sessionStorage)
      .setItem(AUTH_TOKEN_KEY, token);
  }

  clearAccessToken(): void {
    this.browserWindow.localStorage.removeItem(AUTH_TOKEN_KEY);
    this.browserWindow.sessionStorage.removeItem(AUTH_TOKEN_KEY);
  }

  notifyUnauthorized(): void {
    this.browserWindow.dispatchEvent(new CustomEvent("bim-studio-auth-required"));
  }
}
