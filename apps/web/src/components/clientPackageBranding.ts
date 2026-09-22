export const DEFAULT_CLIENT_NAME = "DeepMonkey Studio";
export const CLIENT_ICON_MAX_BYTES = 2 * 1024 * 1024;
export interface ClientPackageBranding { applicationName?: string; iconDataUrl?: string }

export function clientBrandingNameInvalid(value: string | undefined): boolean {
  const name = value?.trim() ?? "";
  return name.length > 80 || /[\u0000-\u001f\u007f]/.test(name);
}

export function normalizedClientBranding(value: ClientPackageBranding): ClientPackageBranding | undefined {
  const name = value.applicationName?.trim();
  if (clientBrandingNameInvalid(name)) throw new Error("invalid_client_branding");
  const result = {
    ...(name && name !== DEFAULT_CLIENT_NAME ? { applicationName: name } : {}),
    ...(value.iconDataUrl ? { iconDataUrl: value.iconDataUrl } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

/** Validate the actual local bytes; filenames and MIME labels are not trusted. */
export async function readClientIcon(file: File): Promise<string> {
  if (!file.size || file.size > CLIENT_ICON_MAX_BYTES) throw new Error("icon_size");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const ico = bytes.length >= 6 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1
    && bytes[3] === 0 && (bytes[4]! | bytes[5]! << 8) > 0;
  if (!png && !ico) throw new Error("icon_format");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return `data:${png ? "image/png" : "image/x-icon"};base64,${btoa(binary)}`;
}
