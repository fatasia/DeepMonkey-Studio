import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readDashboardWindowsExecutable } from "./dashboardWindowsExecutable.js";
import { applyNativeExecutableBranding } from "./nativeExecutableBranding.js";
import type { ClientPackageBranding } from "./clientPackageBranding.js";

export interface NativeExecutableOptions { signal?: AbortSignal; expectedSha256?: string; branding?: ClientPackageBranding }

/** Callers validate domain authority before invoking this byte-packaging boundary. */
export async function embedVerifiedNativeArtifact(artifact: Uint8Array, nativeExecutable: string,
  options: NativeExecutableOptions = {}): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  if (!artifact.byteLength || artifact.byteLength > 256 * 1024 ** 2) throw new Error("Embedded Native payload exceeds 256 MiB or is empty");
  const payload = Buffer.from(artifact);
  const executable = await readDashboardWindowsExecutable(nativeExecutable, options.signal, options.expectedSha256);
  if (executable.length >= 48 && executable.subarray(-48, -40).equals(Buffer.from("DMDASH01", "ascii"))) {
    throw new Error("Native executable already contains a Dashboard overlay");
  }
  // 在已验证候选的副本上更新默认图标，缓存 EXE 与原发布校验哈希保持不变。
  const iconIco = options.branding?.iconIco ?? await readFile(
    new URL("../../desktop/src-tauri/icons/icon.ico", import.meta.url), { signal: options.signal },
  );
  const branded = await applyNativeExecutableBranding(executable, { ...options.branding, iconIco }, options.signal);
  const license = await readFile(new URL("../../../LICENSE", import.meta.url), { encoding: "utf8", signal: options.signal });
  const thirdPartyNotices = await readFile(new URL("../../../THIRD_PARTY_NOTICES.md", import.meta.url), { encoding: "utf8", signal: options.signal });
  const notices = Buffer.from(JSON.stringify({ schema: "deep-engine.embedded-notices", schemaVersion: 1, license, thirdPartyNotices }), "utf8");
  if (notices.length > 8 * 1024 ** 2) throw new Error("Embedded Native notices exceed 8 MiB");
  const noticeFooter = Buffer.alloc(16);
  noticeFooter.writeBigUInt64LE(BigInt(notices.length), 0); noticeFooter.write("DMLICS01", 8, "ascii");
  const footer = Buffer.alloc(48);
  footer.write("DMDASH01", 0, "ascii"); footer.writeBigUInt64LE(BigInt(payload.length), 8);
  createHash("sha256").update(payload).digest().copy(footer, 16);
  options.signal?.throwIfAborted();
  return Buffer.concat([branded, notices, noticeFooter, payload, footer]);
}
