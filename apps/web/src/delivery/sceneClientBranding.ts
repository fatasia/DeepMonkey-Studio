import { CLIENT_ICON_MAX_BYTES, normalizedClientBranding, type ClientPackageBranding } from "../components/clientPackageBranding";

/** Delivery accepts only local, bounded PNG/ICO bytes; URLs are never fetched. */
export function freezeSceneClientBranding(value?: ClientPackageBranding): ClientPackageBranding | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["applicationName", "iconDataUrl"].includes(key))
    || (value.applicationName !== undefined && typeof value.applicationName !== "string")
    || (value.iconDataUrl !== undefined && typeof value.iconDataUrl !== "string")) throw new Error("invalid_client_branding");
  const branding = normalizedClientBranding(value);
  if (branding?.iconDataUrl) decodeSceneClientIcon(branding.iconDataUrl);
  return branding ? Object.freeze({ ...branding }) : undefined;
}

export function decodeSceneClientIcon(dataUrl: string): { path: string; content: Uint8Array } {
  if (dataUrl.length > Math.ceil(CLIENT_ICON_MAX_BYTES / 3) * 4 + 64) throw new Error("icon_size");
  const match = /^data:(image\/png|image\/(?:x-icon|vnd.microsoft.icon));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error("icon_format");
  let binary: string;
  try { binary = atob(match[2]!); } catch { throw new Error("icon_format"); }
  if (!binary.length || binary.length > CLIENT_ICON_MAX_BYTES) throw new Error("icon_size");
  const content = Uint8Array.from(binary, character => character.charCodeAt(0));
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => content[index] === byte);
  const ico = content.length >= 6 && content[0] === 0 && content[1] === 0 && content[2] === 1
    && content[3] === 0 && (content[4]! | content[5]! << 8) > 0;
  if (match[1] === "image/png" ? !png : !ico) throw new Error("icon_format");
  return { path: `branding/icon.${png ? "png" : "ico"}`, content };
}
