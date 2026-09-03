import { verifyServerProfile, type NamedServerProfile, type ServerHandshakeResult } from "@bim-studio/server-sdk";
import { BrowserHostAdapter } from "./browserHostAdapter.js";
import { isTauriRuntime, TauriHostAdapter } from "./tauriHostAdapter.js";
import { readDesktopRuntimeMode, storeDesktopRuntimeMode, type DesktopRuntimeMode } from "./desktopRuntimeMode.js";

const runtimeWindow = typeof window === "undefined" ? undefined : window;
const desktop = runtimeWindow && isTauriRuntime(runtimeWindow) ? new TauriHostAdapter(runtimeWindow) : undefined;
const browser = runtimeWindow && !desktop ? new BrowserHostAdapter(runtimeWindow) : undefined;
const serverRenderHost = {
  getServerProfile: () => ({ baseUrl: "http://localhost" }),
  getAccessToken: () => "",
  setAccessToken: () => undefined,
  clearAccessToken: () => undefined,
  notifyUnauthorized: () => undefined,
};

/** SSR and static component tests receive an inert host without touching browser globals. */
export const runtimeHost = desktop ?? browser ?? serverRenderHost;

export function isDesktopRuntime(): boolean {
  return Boolean(desktop);
}

export function currentDesktopRuntimeMode(): DesktopRuntimeMode | undefined {
  return desktop ? readDesktopRuntimeMode() : undefined;
}

export function selectDesktopRuntimeMode(mode: DesktopRuntimeMode): void {
  if (!desktop) throw new Error("当前不是 Tauri 客户端");
  storeDesktopRuntimeMode(mode);
}

export async function hydrateDesktopServer(): Promise<{
  profile?: NamedServerProfile;
  handshake?: ServerHandshakeResult;
}> {
  if (!desktop) return {};
  const profile = await desktop.hydrateServerProfile();
  if (!profile) return {};
  const handshake = await verifyServerProfile(profile, desktop);
  if (handshake.status === "connected") await desktop.saveServerProfile(handshake.profile);
  return { profile, handshake };
}

export async function connectDesktopServer(profile: NamedServerProfile): Promise<ServerHandshakeResult> {
  if (!desktop) throw new Error("当前不是 Tauri 客户端");
  const handshake = await verifyServerProfile(profile, desktop);
  if (handshake.status === "connected") await desktop.saveServerProfile(handshake.profile);
  return handshake;
}
