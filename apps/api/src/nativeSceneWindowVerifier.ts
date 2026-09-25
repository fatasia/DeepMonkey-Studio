import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export interface NativeSceneWindowEvidence {
  schemaVersion: 1;
  scope: "native-window";
  sourceSha256: string;
  executable: string;
  executableSha256: string;
  packageHash: { algorithm: "sha256"; value: string };
  nonce: string;
  requestedFrames: number;
  verifiedAt: string;
  report: { schemaVersion: 1; scope: "native-window"; packageHash: string; nonce: string;
    width: number; height: number; presentedFrames: number; backend: string; gpuErrorsClean: true;
    device?: Record<string, unknown>; deviceFingerprintSha256?: string };
}

/** 配置来自服务启动设置；调用请求只能传入服务器私有候选文件和取消信号。 */
export function createNativeSceneWindowVerifier(config: { nativeExecutable: string; frames?: number; bundleDirectory?: URL }) {
  const configuration = { ...config };
  const directory = configuration.bundleDirectory ?? new URL("../dist/native-scene-compiler/", import.meta.url);
  return async (packagePath: string, signal?: AbortSignal): Promise<NativeSceneWindowEvidence> => {
    signal?.throwIfAborted();
    let bytes: Buffer, manifest: { schemaVersion: number; windowVerifierSha256: string };
    try {
      [bytes, manifest] = await Promise.all([readFile(new URL("window-verifier.mjs", directory)),
        readFile(new URL("manifest.json", directory), "utf8").then(value => JSON.parse(value))]);
    } catch { throw new Error("Native 窗口验证器不可用，请先构建 API 产物"); }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (manifest.schemaVersion !== 1 || manifest.windowVerifierSha256 !== sha256) throw new Error("Native 窗口验证器内容校验失败");
    signal?.throwIfAborted();
    const module = await import(`data:text/javascript;base64,${bytes.toString("base64")}`) as {
      verifySceneNativeWindow(options: { packagePath: string; nativeExecutable: string; frames?: number; signal?: AbortSignal }): Promise<NativeSceneWindowEvidence>;
    };
    return module.verifySceneNativeWindow({ packagePath, nativeExecutable: configuration.nativeExecutable,
      ...(configuration.frames === undefined ? {} : { frames: configuration.frames }), ...(signal ? { signal } : {}) });
  };
}
