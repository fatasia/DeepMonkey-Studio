import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(currentFile), "../..");
const crateRoot = path.join(repositoryRoot, "packages/deep-engine-native");
const outDir = path.join(repositoryRoot, "test-output/industrial-worker-licenses-20260918");

/**
 * industrial-worker-host.exe 的 cargo 依赖闭包审计(离线,--locked)。
 * 口径:crate 级 normal 依赖闭包 —— host bin 链接本 crate lib,依赖以并集为上界;
 * 许可合规按上界盘点是保守方向,不据此宣称精确链接子集。
 */
function loadCargoMetadata() {
  const result = spawnSync("cargo", ["metadata", "--offline", "--locked", "--format-version", "1"], {
    cwd: crateRoot, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw new Error(`cargo metadata failed to spawn: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`cargo metadata failed: ${((result.stderr ?? "") + (result.stdout ?? "")).slice(0, 400)}`);
  return JSON.parse(result.stdout);
}

function dependencyClosure(metadata, rootId) {
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const seen = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      // dep_kind 1 = normal;忽略 dev/build 依赖。
      if (dep.dep_kinds.some((kind) => kind.kind === null || kind.kind === "normal")) queue.push(dep.pkg);
    }
  }
  return seen;
}

async function main() {
  const metadata = loadCargoMetadata();
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const root = [...packages.values()].find((pkg) => pkg.name === "deep-engine-native");
  if (!root) throw new Error("deep-engine-native not found in cargo metadata");
  const closure = dependencyClosure(metadata, root.id);
  const entries = [...closure].map((id) => {
    const pkg = packages.get(id);
    const firstParty = id === root.id;
    return {
      name: pkg.name, version: pkg.version,
      // 第一方根 crate 由仓库 LICENSE(DMCSL-1.0)与 Cargo.toml license 声明,不由 crates.io 元数据提供。
      license: firstParty ? "LicenseRef-Deep-Monkey-Community-1.0" : (pkg.license ?? "NOASSERTION"),
      licenseSource: firstParty ? "repository LICENSE + Cargo.toml license" : "crates.io metadata",
      repository: pkg.repository ?? null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const noassertion = entries.filter((entry) => entry.license === "NOASSERTION" || entry.license === null);

  const notices = await readFile(path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  const windowsSys = entries.find((entry) => entry.name === "windows-sys");
  const noticesCoverWindowsSys = Boolean(windowsSys && notices.includes(`\`${windowsSys.name}\``));

  const evidence = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    scope: "industrial-worker-host.exe 随附分发的 cargo normal 依赖闭包(crate 级上界,--offline --locked);C++ 解析器源依赖见 corpus-manifest.json 与本目录外许可清单文档。",
    root: { name: root.name, version: root.version },
    lockSha256: createHash("sha256").update(await readFile(path.join(crateRoot, "Cargo.lock"))).digest("hex"),
    packageCount: entries.length,
    packages: entries,
    noassertionPackages: noassertion.map((entry) => entry.name),
    noticesCheck: {
      windowsSysVersion: windowsSys?.version ?? null,
      coveredByThirdPartyNotices: noticesCoverWindowsSys,
    },
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  const failures = [];
  if (!noticesCoverWindowsSys) failures.push("windows-sys is not identified in THIRD_PARTY_NOTICES.md");
  if (noassertion.length) failures.push(`NOASSERTION licenses require evidence: ${noassertion.map((entry) => entry.name).join(", ")}`);
  if (failures.length) {
    console.error(`industrial worker license audit failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(`industrial worker license audit passed: ${entries.length} crates in closure, evidence at ${path.join(outDir, "evidence.json")}`);
  }
}

await main();
