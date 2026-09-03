import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalObjectStore } from "./objects";
import { ScriptDependencyService } from "./scriptDependencyService";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ScriptDependencyService", () => {
  it("将上传的 JavaScript 打包、锁定哈希并持久化", async () => {
    const { directory, service } = await fixture();
    const dependency = await service.installUpload("project-1", "@plant/math", "math.js", Buffer.from("export const speed = 12;"));

    expect(dependency).toMatchObject({ specifier: "@plant/math", source: "upload", requested: "math.js", size: expect.any(Number) });
    expect(dependency.integrity).toMatch(/^sha256-/);
    const code = await readFile(path.join(directory, "projects", "project-1", "script-dependencies", dependency.id, "index.mjs"), "utf8");
    expect(code).toContain("speed = 12");
  });

  it("在启动 npm 前拒绝浮动版本与越界模块名", async () => {
    const { service } = await fixture();
    await expect(service.installNpm("project-1", { packageName: "dayjs", version: "latest" })).rejects.toThrow("固定版本");
    await expect(service.installUpload("project-1", "../escape", "unsafe.js", Buffer.from("export default 1"))).rejects.toThrow("格式无效");
    await expect(service.installUpload("../outside", "safe-module", "safe.js", Buffer.from("export default 1"))).rejects.toThrow("projectId");
  });

  it("拒绝空文件和二进制伪装的 JavaScript", async () => {
    const { service } = await fixture();
    await expect(service.installUpload("project-1", "empty", "empty.js", Buffer.alloc(0))).rejects.toThrow("空文件");
    await expect(service.installUpload("project-1", "binary", "binary.js", Buffer.from([1, 0, 2]))).rejects.toThrow("不是文本");
  });
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-studio-script-dependency-test-"));
  temporaryDirectories.push(directory);
  const objects = new LocalObjectStore(directory);
  await objects.init();
  return { directory, service: new ScriptDependencyService({ dataDir: directory, objects }) };
}
