import type { AuthStore, ServerProfile } from "@bim-studio/server-sdk";
import { browserApiOrigin } from './browserRuntimeConfig';

const AUTH_TOKEN_KEY = "bim-studio-auth-token";

export class BrowserHostAdapter implements AuthStore {
  private readonly serverOrigin: string;
  private readonly tokenKey: string;
  constructor(private readonly browserWindow: Window, configuredOrigin?: string) {
    this.serverOrigin = browserApiOrigin(browserWindow.location.origin, configuredOrigin);
    this.tokenKey = this.serverOrigin === browserWindow.location.origin ? AUTH_TOKEN_KEY
      : `${AUTH_TOKEN_KEY}@${this.serverOrigin}`;
  }

  getServerProfile(): ServerProfile {
    return { baseUrl: this.serverOrigin };
  }

  getAccessToken(): string {
    return this.browserWindow.localStorage.getItem(this.tokenKey)
      ?? this.browserWindow.sessionStorage.getItem(this.tokenKey)
      ?? "";
  }

  setAccessToken(token: string, persistent: boolean): void {
    this.clearAccessToken();
    (persistent ? this.browserWindow.localStorage : this.browserWindow.sessionStorage)
      .setItem(this.tokenKey, token);
  }

  clearAccessToken(): void {
    this.browserWindow.localStorage.removeItem(this.tokenKey);
    this.browserWindow.sessionStorage.removeItem(this.tokenKey);
  }

  notifyUnauthorized(): void {
    this.browserWindow.dispatchEvent(new CustomEvent("bim-studio-auth-required"));
  }
}
