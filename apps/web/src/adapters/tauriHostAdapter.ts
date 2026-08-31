import { invoke } from "@tauri-apps/api/core";
import type { AuthStore, NamedServerProfile } from "@bim-studio/server-sdk";
import { isLocalDesktopMode, localDesktopApiOrigin } from "./desktopRuntimeMode.js";

export type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export class TauriHostAdapter implements AuthStore {
  private profile: NamedServerProfile | undefined;
  private accessToken = "";

  constructor(
    private readonly browserWindow: Window,
    private readonly invokeCommand: TauriInvoke = invoke
  ) {}

  async hydrateServerProfile(): Promise<NamedServerProfile | undefined> {
    this.profile = await this.invokeCommand<NamedServerProfile | undefined>("get_server_profile");
    return this.currentServerProfile();
  }

  currentServerProfile(): NamedServerProfile | undefined {
    return this.profile ? { ...this.profile } : undefined;
  }

  getServerProfile(): NamedServerProfile {
    if (isLocalDesktopMode(this.browserWindow)) {
      return { id: "desktop-local", name: "本地工作台", baseUrl: localDesktopApiOrigin() };
    }
    const profile = this.currentServerProfile();
    if (!profile) throw new Error("尚未配置服务器，请先完成连接向导");
    return profile;
  }

  async saveServerProfile(profile: NamedServerProfile): Promise<NamedServerProfile> {
    this.profile = await this.invokeCommand<NamedServerProfile>("set_server_profile", { profile });
    return this.getServerProfile();
  }

  async clearServerProfile(): Promise<void> {
    await this.invokeCommand<void>("clear_server_profile");
    this.profile = undefined;
    this.clearAccessToken();
  }

  getAccessToken(): string {
    return this.accessToken;
  }

  setAccessToken(token: string, _persistent: boolean): void {
    // M7 foundation deliberately keeps the token in memory until an audited
    // OS-backed credential adapter is installed. "Remember me" is not faked
    // with plaintext WebView storage.
    this.accessToken = token;
  }

  clearAccessToken(): void {
    this.accessToken = "";
  }

  notifyUnauthorized(): void {
    this.clearAccessToken();
    this.browserWindow.dispatchEvent(new CustomEvent("bim-studio-auth-required"));
  }
}

export function isTauriRuntime(browserWindow: Window): boolean {
  return "__TAURI_INTERNALS__" in browserWindow;
}
