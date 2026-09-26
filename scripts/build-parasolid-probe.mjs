import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * ps-schema-probe CLI 构建脚本（可选工具，不进入默认构建链）。
 *
 * - bin crate：tools/ps-schema-probe（薄包装，path 依赖指向本地解包的 parasolid-kit
 *   v0.2.0(MIT AND Apache-2.0) 的 parasolid-core；kit 位于 data/external-assets，
 *   不入仓、不随默认构建分发）。
 * - 产物：apps/api/dist/ps-schema-probe/ps-schema-probe(.exe) + manifest.json。
 * - vendored kit 不存在时跳过并退出 0（运行时探测不到 CLI，即自动维持既有双档行为）。
 * - 手动执行：node scripts/build-parasolid-probe.mjs
 *   （可用 PARASOLID_KIT_PATH 覆盖 kit 解包目录；PARASOLID_PROBE_TARGET_DIR 覆盖 cargo target 目录）。
 */
const root = path.resolve(import.meta.dirname, "..");
const crate = path.join(root, "tools/ps-schema-probe");
const kitDefault = path.join(root,
  "data/external-assets/industrial-format-plan/dependencies/extracted/parasolid-kit-v0.2.0");
const kitPath = process.env.PARASOLID_KIT_PATH?.trim() || kitDefault;
const coreManifest = path.join(kitPath, "crates/parasolid-core/Cargo.toml");

if (!existsSync(coreManifest)) {
  console.log(`ps-schema-probe skipped: vendored parasolid-core not found at ${coreManifest}`);
  console.log("Deploy ps-schema-probe by extracting parasolid-kit v0.2.0 and re-running this script.");
} else {
  const targetDir = process.env.PARASOLID_PROBE_TARGET_DIR?.trim()
    || path.join(crate, "target/release");
  const command = spawn("cargo", ["build", "--locked", "--release", "--target-dir", targetDir, "-j", "2"], {
    cwd: crate, windowsHide: true, stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => { command.once("error", reject); command.once("close", resolve); });
  if (code !== 0) throw new Error(`ps-schema-probe build failed: ${code}`);
  const executableName = process.platform === "win32" ? "ps-schema-probe.exe" : "ps-schema-probe";
  const output = path.join(root, "apps/api/dist/ps-schema-probe");
  await mkdir(output, { recursive: true });
  await copyFile(path.join(targetDir, executableName), path.join(output, executableName));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const sources = ["Cargo.toml", "Cargo.lock", "src/main.rs"];
  const inputs = await Promise.all(sources.map(async source => ({ path: source, sha256: hash(await readFile(path.join(crate, source))) })));
  const executable = await readFile(path.join(output, executableName));
  await writeFile(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1,
    tool: "ps-schema-probe", dependency: "parasolid-core 0.2.0 (MIT AND Apache-2.0, vendored, not redistributed)",
    platform: process.platform, bytes: executable.length, sha256: hash(executable), inputs }, null, 2));
  console.log(`ps-schema-probe built: ${executable.length} bytes ${hash(executable)}`);
}
