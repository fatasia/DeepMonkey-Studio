import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";

const execFileAsync = promisify(execFile);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** 场景包在模板 APK 内的固定资产位;android_main 按此路径物化。 */
export const ANDROID_SCENE_ASSET_PATH = "assets/runtime-package.json";

export interface DashboardAndroidSigningConfig {
  /** Keystore 文件字节;由调用方从部署侧或上传流读取,禁止接受路径穿越。 */
  readonly keystore: Uint8Array;
  readonly storePassword: string;
  readonly keyAlias: string;
  readonly keyPassword?: string;
}

export interface DashboardAndroidApkDependencies {
  /** 部署固定的模板 APK 绝对路径;HTTP 输入不可覆盖。 */
  readonly templateApkPath: string;
  /** 模板 APK 固定哈希;配置后打包前校验,防止模板被替换。 */
  readonly templateApkSha256?: string;
  /** Android build-tools 目录(zipalign/apksigner 所在),部署固定。 */
  readonly buildToolsPath: string;
  /** 部署侧默认签名;请求未携带签名配置时使用。 */
  readonly defaultSigning?: () => Promise<DashboardAndroidSigningConfig | undefined>;
}

export interface DashboardAndroidApkOptions {
  readonly signal?: AbortSignal;
  readonly signing?: DashboardAndroidSigningConfig;
}

export interface DashboardAndroidApkResult {
  readonly apk: Uint8Array;
  readonly scenePackageSha256: string;
  readonly templateApkSha256: string;
}

/**
 * 场景安卓发布首片:把候选的权威 Deep Runtime Package 注入模板 APK 的固定资产位,
 * 经 zipalign 对齐后用 apksigner 重签。签名口令只暂存在独占临时目录，finally 清理且不进日志。
 */
export async function createDashboardAndroidApk(
  runtimePackageBytes: Uint8Array,
  dependencies: DashboardAndroidApkDependencies,
  options: DashboardAndroidApkOptions = {},
): Promise<DashboardAndroidApkResult> {
  options.signal?.throwIfAborted();
  if (!path.isAbsolute(dependencies.templateApkPath)) {
    throw new Error("Android template APK path must be absolute");
  }
  if (!path.isAbsolute(dependencies.buildToolsPath)) {
    throw new Error("Android build-tools path must be absolute");
  }
  const signing = options.signing ?? (await dependencies.defaultSigning?.());
  if (!signing) throw new Error("Android APK packaging requires a signing configuration");
  const templateBytes = await readFile(dependencies.templateApkPath);
  if (dependencies.templateApkSha256 !== undefined && sha256(templateBytes) !== dependencies.templateApkSha256) {
    throw new Error("Android template APK SHA-256 mismatch");
  }
  const injected = await injectSceneAsset(templateBytes, runtimePackageBytes, options.signal);
  return {
    apk: await alignAndSign(injected, dependencies.buildToolsPath, signing, options.signal),
    scenePackageSha256: sha256(runtimePackageBytes),
    templateApkSha256: sha256(templateBytes),
  };
}

/**
 * 注入场景资产并保持 APK 结构合法:
 * - `resources.arsc` 与 `.so` 保持 STORED(targetSdk 30+ 要求未压缩 + 页对齐);
 * - 移除旧 META-INF 签名文件,交给 apksigner 重新签名;
 * - 固定条目时间戳,同输入产生同字节,便于哈希审计。
 */
export async function injectSceneAsset(
  templateBytes: Uint8Array,
  runtimePackageBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const template = await JSZip.loadAsync(templateBytes);
  for (const name of Object.keys(template.files)) {
    if (/^META-INF\/.*\.(SF|RSA|DSA|EC)$/i.test(name) || name === "META-INF/MANIFEST.MF") {
      template.remove(name);
    }
  }
  template.file(ANDROID_SCENE_ASSET_PATH, runtimePackageBytes, {
    date: new Date("2000-01-01T00:00:00Z"),
    createFolders: false,
  });
  const zip = new JSZip();
  for (const entry of Object.values(template.files)) {
    if (entry.dir) continue;
    const bytes = await entry.async("uint8array");
    const stored = /\.arsc$|\.so$/i.test(entry.name);
    zip.file(entry.name, bytes, {
      date: new Date("2000-01-01T00:00:00Z"),
      createFolders: false,
      compression: stored ? "STORE" : "DEFLATE",
      ...(stored ? {} : { compressionOptions: { level: 6 } }),
    });
  }
  signal?.throwIfAborted();
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", platform: "DOS" }, () => signal?.throwIfAborted());
}

/** 4 字节对齐 + v1/v2 重签;zipalign 必须先于 apksigner(v2 签名对长度敏感)。
 * apksigner 是 .bat,Node ≥ 20 强制 shell:true 才能拉起;口令走 `file:` 协议,
 * 避免口令出现在命令行参数或 shell 插值里。 */
async function alignAndSign(
  unaligned: Uint8Array,
  buildToolsPath: string,
  signing: DashboardAndroidSigningConfig,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const work = await mkdtemp(path.join(tmpdir(), "deep-android-apk-"));
  try {
    const unalignedPath = path.join(work, "unaligned.apk");
    const alignedPath = path.join(work, "aligned.apk");
    const signedPath = path.join(work, "signed.apk");
    const keystorePath = path.join(work, "signing.keystore");
    const storePassPath = path.join(work, "store-pass.txt");
    const keyPassPath = path.join(work, "key-pass.txt");
    await writeFile(unalignedPath, unaligned);
    await writeFile(keystorePath, signing.keystore);
    await writeFile(storePassPath, signing.storePassword, "utf8");
    await writeFile(keyPassPath, signing.keyPassword ?? signing.storePassword, "utf8");
    signal?.throwIfAborted();
    await execFileAsync(path.join(buildToolsPath, "zipalign.exe"), ["-f", "-p", "4", unalignedPath, alignedPath], { signal });
    const apksigner = apksignerJava(buildToolsPath);
    await execFileAsync(
      apksigner.executable,
      [
        ...apksigner.prefix,
        "sign",
        "--min-sdk-version", "24",
        "--ks", keystorePath,
        "--ks-key-alias", signing.keyAlias,
        "--ks-pass", `file:${storePassPath}`,
        "--key-pass", `file:${keyPassPath}`,
        "--out", signedPath,
        alignedPath,
      ],
      { signal, windowsHide: true },
    );
    await execFileAsync(
      apksigner.executable,
      [...apksigner.prefix, "verify", "--min-sdk-version", "24", signedPath],
      { signal, windowsHide: true },
    );
    return new Uint8Array(await readFile(signedPath));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** 直接运行官方 apksigner.jar，避免 `.bat + shell:true` 的参数拼接与注入风险。 */
function apksignerJava(buildToolsPath: string): { executable: string; prefix: readonly string[] } {
  const executable = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
  return { executable, prefix: ["-Xmx1024M", "-Xss1m", "-jar", path.join(buildToolsPath, "lib", "apksigner.jar")] };
}
