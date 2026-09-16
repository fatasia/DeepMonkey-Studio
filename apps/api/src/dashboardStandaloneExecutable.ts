import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDashboardOfflineNativeLaunchPlan } from "./dashboardOfflineNativeLauncher.js";
import { readDashboardWindowsExecutable } from "./dashboardWindowsExecutable.js";

/** 末尾合同与 Native overlay loader 共用：magic8 + payload长度u64LE + 原字节SHA256。 */
export async function createDashboardStandaloneExecutable(
  archiveBytes: Uint8Array,
  nativeExecutable: string,
  options: { signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  const plan = createDashboardOfflineNativeLaunchPlan(archiveBytes);
  if (plan.artifact.byteLength > 256 * 1024 ** 2) throw new Error("Embedded Dashboard payload exceeds 256 MiB");
  const executable = await readDashboardWindowsExecutable(nativeExecutable, options.signal);
  if (executable.length >= 48 && executable.subarray(-48, -40).equals(Buffer.from("DMDASH01", "ascii"))) {
    throw new Error("Native executable already contains a Dashboard overlay");
  }
  const license = await readFile(new URL("../../../LICENSE", import.meta.url), { encoding: "utf8", signal: options.signal });
  const thirdPartyNotices = await readFile(new URL("../../../THIRD_PARTY_NOTICES.md", import.meta.url), { encoding: "utf8", signal: options.signal });
  const notices = Buffer.from(JSON.stringify({ schema: "deep-engine.embedded-notices", schemaVersion: 1, license, thirdPartyNotices }), "utf8");
  if (notices.length > 8 * 1024 ** 2) throw new Error("Embedded Dashboard notices exceed 8 MiB");
  const noticeFooter = Buffer.alloc(16);
  noticeFooter.writeBigUInt64LE(BigInt(notices.length), 0);
  noticeFooter.write("DMLICS01", 8, "ascii");
  const footer = Buffer.alloc(48);
  footer.write("DMDASH01", 0, "ascii");
  footer.writeBigUInt64LE(BigInt(plan.artifact.byteLength), 8);
  createHash("sha256").update(plan.artifact).digest().copy(footer, 16);
  options.signal?.throwIfAborted();
  return Buffer.concat([executable, notices, noticeFooter, plan.artifact, footer]);
}
