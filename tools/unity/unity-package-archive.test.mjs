import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("./com.bim-studio.bridge", import.meta.url));
const archivePath = fileURLToPath(new URL("../../apps/web/public/downloads/com.bim-studio.bridge-0.6.1.tgz", import.meta.url));

test("公开 Unity tgz 与当前插件源码保持一致", async (context) => {
  const extractionRoot = await mkdtemp(join(tmpdir(), "bim-studio-unity-package-"));
  context.after(() => rm(extractionRoot, { recursive: true, force: true }));
  // 归档先复制进临时目录再用相对路径解包：Git Bash 的 GNU tar 会把 "D:\..." 绝对路径
  // 解析成"远程主机:文件"(Cannot connect to D:),Windows 自带 bsdtar 则无此问题,
  // 相对路径在两种 tar 下行为一致。
  const localArchive = join(extractionRoot, "package.tgz");
  await copyFile(archivePath, localArchive);
  const extraction = spawnSync("tar", ["-xzf", "package.tgz"], { cwd: extractionRoot, encoding: "utf8" });
  assert.equal(extraction.status, 0, extraction.stderr || extraction.stdout);

  const packedRoot = join(extractionRoot, "package");
  const sourceFiles = await relativeFiles(packageRoot);
  const packedFiles = await relativeFiles(packedRoot);
  assert.deepEqual(packedFiles, sourceFiles, "tgz 文件清单必须与插件源码一致");

  for (const path of sourceFiles) {
    const [source, packed] = await Promise.all([
      readFile(join(packageRoot, path), "utf8"),
      readFile(join(packedRoot, path), "utf8"),
    ]);
    assert.equal(normalizeNewlines(packed), normalizeNewlines(source), `${path} 与 tgz 内容不一致`);
  }
});

async function relativeFiles(root) {
  const files = [];
  await collect(root, files);
  return files.map((path) => relative(root, path).replaceAll("\\", "/")).sort();
}

async function collect(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

function normalizeNewlines(value) {
  // pnpm pack 会重写 package.json 并去掉末尾换行；其余文本仍必须逐字一致。
  return value.replaceAll("\r\n", "\n").replace(/\n$/, "");
}
