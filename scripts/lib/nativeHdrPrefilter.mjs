import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeRadianceHdr } from "../../packages/deep-engine/src/textures/radianceHdr.ts";
import { validateRuntimePrefilteredIbl } from "../../packages/deep-engine/src/runtimePackage/environment.ts";

/** The executable is deployment configuration, never taken from author data. */
export async function prefilterNativeHdr(bytes, nativeExecutable, license, signal, intensity=1) {
  if (!path.isAbsolute(nativeExecutable ?? "")) throw new Error("HDR 预过滤缺少已配置的 Native 编译器");
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 32 * 1024 ** 2) throw new Error("HDR 源文件超过 32MiB 预算");
  signal?.throwIfAborted();
  if (!Number.isFinite(intensity) || intensity<0 || intensity>64) throw new Error("HDR 环境强度超出预算");
  const image = decodeRadianceHdr(bytes, { maxDimension: 8192, maxPixels: 2_097_152 });
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const rgb = Buffer.allocUnsafe(image.data.length * 4);
  for (let i = 0; i < image.data.length; i++) rgb.writeFloatLE(image.data[i]*intensity, i * 4);
  const directory = await mkdtemp(path.join(tmpdir(), "deep-hdr-prefilter-"));
  try {
    const request = path.join(directory, "request.json"), output = path.join(directory, "environment.json");
    await writeFile(request, JSON.stringify({ schema: "deep-engine.hdr-prefilter-request.v1", width: image.width, height: image.height,
      rgbFloat32LeBase64: rgb.toString("base64"), sourceHash, license, specularSize: 128 }), { flag: "wx" });
    await promisify(execFile)(nativeExecutable, ["--prefilter-hdr", request, "--output", output], { windowsHide: true, timeout: 45_000, signal, maxBuffer: 1024 * 1024 });
    signal?.throwIfAborted();
    const payload = JSON.parse(await readFile(output, "utf8"));
    validateRuntimePrefilteredIbl(payload, "scene.environment", 1);
    if (payload.source.contentHash.value !== sourceHash || payload.source.license !== license) throw new Error("HDR 预过滤来源回执不匹配");
    return payload;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
