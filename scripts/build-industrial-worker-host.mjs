import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

if (process.platform !== "win32") {
  console.log("Industrial Windows Job host not built on this platform; only process isolation is available");
} else {
  const root = path.resolve(import.meta.dirname, "..");
  const crate = path.join(root, "packages/deep-engine-native");
  const target = "x86_64-pc-windows-msvc";
  const targetDir = path.join(crate, "target/portable-windows");
  const command = spawn("cargo", ["build", "--offline", "--locked", "--release", "--target", target,
    "--target-dir", targetDir, "--bin", "industrial-worker-host", "-j", "2"], {
    cwd: crate, windowsHide: true, stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS: "-C target-feature=+crt-static" },
  });
  const code = await new Promise((resolve, reject) => { command.once("error", reject); command.once("close", resolve); });
  if (code !== 0) throw new Error(`Industrial Job host build failed: ${code}`);
  const output = path.join(root, "apps/api/dist/industrial-worker"); await mkdir(output, { recursive: true });
  const name = "industrial-worker-host.exe";
  await copyFile(path.join(targetDir, target, "release", name), path.join(output, name));
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  const sources = ["Cargo.toml", "Cargo.lock", "build.rs", "src/bin/industrial-worker-host.rs", "src/industrial_worker_host.rs",
    "src/compat_x/windows_job.rs", "src/compat_x/windows_initial_thread.rs"];
  const inputs = await Promise.all(sources.map(async source => ({ path: source, sha256: hash(await readFile(path.join(crate, source))) })));
  const executable = await readFile(path.join(output, name));
  await writeFile(path.join(output, "manifest.json"), JSON.stringify({ schemaVersion: 1, target, crt: "static", bytes: executable.length,
    sha256: hash(executable), inputs }, null, 2));
  console.log(`Industrial Windows Job host built: ${executable.length} bytes ${hash(executable)}`);
}
