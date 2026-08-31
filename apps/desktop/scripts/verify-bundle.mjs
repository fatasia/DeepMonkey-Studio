import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bundleRoot = fileURLToPath(new URL("../src-tauri/target/release/bundle/", import.meta.url));
const desktopExecutable = fileURLToPath(new URL("../src-tauri/target/release/bim-studio-desktop.exe", import.meta.url));
const webDist = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const tauriConfigPath = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
const expectedDirectories = ["nsis", "msi"];
const requiredLocalResources = [
  "index.html",
  "wasm/web-ifc.wasm",
  "wasm/web-ifc-mt.wasm",
  "draco/draco_decoder.wasm",
  "draco/draco_wasm_wrapper.js",
];
const issues = [];
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
const expectedArtifactPrefix = `${tauriConfig.productName}_${tauriConfig.version}_`;
const packagedArtifacts = [];

for (const directory of expectedDirectories) {
  const absoluteDirectory = path.join(bundleRoot, directory);
  if (!existsSync(absoluteDirectory)) {
    issues.push(`缺少 ${directory} 安装包目录`);
    continue;
  }

  const artifacts = readdirSync(absoluteDirectory).filter((name) =>
    name.startsWith(expectedArtifactPrefix) && /\.(exe|msi)$/i.test(name)
  );
  if (artifacts.length === 0) {
    issues.push(`${directory} 目录没有当前产品与版本的安装包（${expectedArtifactPrefix}*）`);
    continue;
  }

  for (const artifact of artifacts) {
    const artifactPath = path.join(absoluteDirectory, artifact);
    const size = statSync(artifactPath).size;
    if (size < 1024 * 1024) issues.push(`${artifact} 体积异常（${size} bytes）`);
    packagedArtifacts.push(artifactPath);
  }
}

if (!existsSync(desktopExecutable) || statSync(desktopExecutable).size < 1024 * 1024) {
  issues.push("缺少或未生成桌面主程序");
}

for (const resource of requiredLocalResources) {
  const pathToResource = path.join(webDist, resource);
  if (!existsSync(pathToResource) || statSync(pathToResource).size === 0) {
    issues.push(`缺少本地打包资源：${resource}`);
  }
}

if (existsSync(desktopExecutable)) {
  const executableTime = statSync(desktopExecutable).mtimeMs;
  const newestLocalResourceTime = Math.max(...requiredLocalResources
    .map((resource) => path.join(webDist, resource))
    .filter(existsSync)
    .map((resource) => statSync(resource).mtimeMs));
  // 安装包必须来自当前前端产物；只检查“文件存在”会让旧包在新构建后继续假通过。
  if (executableTime < newestLocalResourceTime) issues.push("桌面主程序早于当前 Web 产物，请重新执行 desktop:bundle");
  for (const artifact of packagedArtifacts) {
    // Tauri 会在生成每种安装包时再次标记 exe，因此最终 exe 可能晚于安装包；以前端产物为共同基线。
    if (statSync(artifact).mtimeMs < newestLocalResourceTime) issues.push(`${path.basename(artifact)} 早于当前 Web 产物，请重新打包`);
  }
}

if (issues.length > 0) {
  console.error("桌面安装包验收失败：");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(`桌面安装包与本地运行资源验收通过：${bundleRoot}`);
}
