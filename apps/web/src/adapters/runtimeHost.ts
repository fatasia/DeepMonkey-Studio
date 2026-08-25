import { verifyServerProfile, type NamedServerProfile, type ServerHandshakeResult } from "@bim-studio/server-sdk";
import { BrowserHostAdapter } from "./browserHostAdapter.js";
import { isTauriRuntime, TauriHostAdapter } from "./tauriHostAdapter.js";

const desktop = isTauriRuntime(window) ? new TauriHostAdapter(window) : undefined;
const browser = desktop ? undefined : new BrowserHostAdapter(window);

export const runtimeHost = desktop ?? browser!;

export function isDesktopRuntime(): boolean {
  return Boolean(desktop);
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
