import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export async function prepareLocalPublicationRuntime(options) {
  const outputRoot = path.resolve(options.outputRoot);
  const publicationRoot = path.join(outputRoot, "publication");
  const inputs = {
    nativeExecutable: path.resolve(options.nativeExecutable ?? path.join(repositoryRoot,
      "packages/deep-engine-native/target/release/deep-engine-native.exe")),
    nativeProbePackage: path.resolve(options.nativeProbePackage ?? path.join(repositoryRoot,
      "packages/deep-engine-native/tests/fixtures/runtime-package-v1.json")),
    androidTemplate: path.resolve(options.androidTemplate ?? path.join(repositoryRoot,
      "data/android/deep-scene-viewer-template.apk")),
    androidBuildTools: path.resolve(options.androidBuildTools ?? discoverAndroidBuildTools()),
    javaHome: path.resolve(options.javaHome ?? process.env.JAVA_HOME ?? ""),
  };
  await validateInputs(inputs);
  await rm(publicationRoot, { recursive: true, force: true });
  const destinations = {
    nativeExecutable: path.join(publicationRoot, "native/deep-engine-native.exe"),
    nativeProbePackage: path.join(publicationRoot, "native/runtime-package-probe.json"),
    androidTemplate: path.join(publicationRoot, "android/deep-scene-viewer-template.apk"),
    androidBuildTools: path.join(publicationRoot, "android/build-tools"),
    javaHome: path.join(publicationRoot, "android/jre"),
  };
  await Promise.all([
    copyFile(inputs.nativeExecutable, destinations.nativeExecutable),
    copyFile(inputs.nativeProbePackage, destinations.nativeProbePackage),
    copyFile(inputs.androidTemplate, destinations.androidTemplate),
    copyFile(path.join(inputs.androidBuildTools, "zipalign.exe"), path.join(destinations.androidBuildTools, "zipalign.exe")),
    copyFile(path.join(inputs.androidBuildTools, "lib/apksigner.jar"), path.join(destinations.androidBuildTools, "lib/apksigner.jar")),
  ]);
  await run(path.join(inputs.javaHome, "bin/jlink.exe"), ["--add-modules", "java.base,java.logging", "--strip-debug",
    "--no-header-files", "--no-man-pages", "--output", destinations.javaHome]);
  const resources = {
    nativeExecutable: await describeFile(outputRoot, destinations.nativeExecutable),
    nativeProbePackage: await describeFile(outputRoot, destinations.nativeProbePackage),
    androidTemplate: await describeFile(outputRoot, destinations.androidTemplate),
    androidZipalign: await describeFile(outputRoot, path.join(destinations.androidBuildTools, "zipalign.exe")),
    androidApksigner: await describeFile(outputRoot, path.join(destinations.androidBuildTools, "lib/apksigner.jar")),
    javaExecutable: await describeFile(outputRoot, path.join(destinations.javaHome, "bin/java.exe")),
  };
  const manifest = {
    schema: "deep-monkey.local-publication-runtime", schemaVersion: 1,
    resources,
    environment: {
      NATIVE_SCENE_VERIFIER_EXECUTABLE: resources.nativeExecutable.path,
      JAVA_HOME: relative(outputRoot, destinations.javaHome),
      DASHBOARD_NATIVE_DEPLOYMENT_FILE: "@generated:workspace/config/dashboard-native.json",
      THREE_SCENE_VIEWER_LAUNCHER_EXECUTABLE: "@runtime:current-executable",
    },
    dashboardDeploymentTemplate: {
      nativeExecutable: { resource: "nativeExecutable" },
      deviceFingerprint: { mode: "runtime-local", probePackagePath: { resource: "nativeProbePackage" } },
      configuration: { locale: "zh-CN", packageVersion: "0.1.0" },
      androidApk: {
        templateApkPath: { resource: "androidTemplate" },
        templateApkSha256: resources.androidTemplate.sha256,
        buildToolsPath: { relativePath: relative(outputRoot, destinations.androidBuildTools) },
      },
    },
    materialization: {
      resourceRoot: ".",
      generatedDashboardDeployment: "workspace/config/dashboard-native.json",
      note: "Resolve every resource/path relative to this manifest, write absolute paths to the generated deployment file, then inject environment values.",
    },
    threeWebview: {
      mode: "generic-launcher", installedBundleAvailable: true,
      launcher: "@runtime:current-executable",
      description: "The installed desktop executable is reused as a fixed launcher; each delivery appends a verified, read-only scene payload without rebuilding the client.",
    },
  };
  await writeFile(path.join(outputRoot, "publication-runtime.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function discoverAndroidBuildTools() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
    ?? path.join(process.env.LOCALAPPDATA ?? "", "Android/Sdk");
  return path.join(sdk, "build-tools/35.0.0");
}

async function validateInputs(inputs) {
  const [native, probe, apk, zipalign, apksigner, jlink] = await Promise.all([
    boundedFile(inputs.nativeExecutable, 1024 * 1024, "Native executable"),
    boundedFile(inputs.nativeProbePackage, 64, "Native probe package"),
    boundedFile(inputs.androidTemplate, 1024 * 1024, "Android template"),
    boundedFile(path.join(inputs.androidBuildTools, "zipalign.exe"), 1024, "Android zipalign"),
    boundedFile(path.join(inputs.androidBuildTools, "lib/apksigner.jar"), 1024, "Android apksigner"),
    boundedFile(path.join(inputs.javaHome, "bin/jlink.exe"), 1024, "JDK jlink"),
  ]);
  if (!(await readPrefix(inputs.nativeExecutable, 2)).equals(Buffer.from("MZ"))) throw new Error("Native executable is not a PE file");
  if (!(await readPrefix(inputs.androidTemplate, 2)).equals(Buffer.from("PK"))) throw new Error("Android template is not an APK/ZIP file");
  return { native, probe, apk, zipalign, apksigner, jlink };
}

async function boundedFile(file, minimumBytes, label) {
  const info = await stat(file);
  if (!info.isFile() || info.size < minimumBytes) throw new Error(`${label} is missing or truncated: ${file}`);
  return info;
}

async function readPrefix(file, count) { return (await readFile(file)).subarray(0, count); }
async function copyFile(source, destination) { await mkdir(path.dirname(destination), { recursive: true }); await cp(source, destination); }
function relative(root, file) { return path.relative(root, file).replaceAll("\\", "/"); }
async function describeFile(root, file) {
  const bytes = await readFile(file);
  return { path: relative(root, file), bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed with exit code ${code}`)));
  });
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("Expected --output <directory> and optional resource path pairs");
    values[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  if (!values.output) throw new Error("Expected --output <directory>");
  const manifest = await prepareLocalPublicationRuntime({ ...values, outputRoot: values.output });
  console.log(`Local publication runtime prepared: ${path.resolve(values.output)}`);
  console.log(`Native ${manifest.resources.nativeExecutable.sha256}; Android ${manifest.resources.androidTemplate.sha256}`);
}
