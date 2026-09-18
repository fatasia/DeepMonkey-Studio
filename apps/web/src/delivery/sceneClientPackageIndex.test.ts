import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexSceneClientArchiveFiles, validateSceneClientArchivePaths, type SceneClientArchiveFile } from "./sceneClientPackageIndex";

afterEach(() => vi.restoreAllMocks());
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

describe("scene client archive index", () => {
  it("hashes actual UTF-8 and binary bytes with deterministic path order", async () => {
    const files: SceneClientArchiveFile[] = [
      { path: "资源/中文 名称.txt", content: "中文 🚀\n", sourceUrl: "https://example.test/source" },
      { path: "a.bin", content: new Uint8Array([0, 128, 255]).buffer },
      { path: "B.txt", content: "" },
    ];
    const expected = [
      { path: "B.txt", bytes: 0, sha256: sha(""), sourceUrl: "generated" },
      { path: "a.bin", bytes: 3, sha256: sha(new Uint8Array([0, 128, 255])), sourceUrl: "generated" },
      { path: "资源/中文 名称.txt", bytes: new TextEncoder().encode("中文 🚀\n").byteLength, sha256: sha("中文 🚀\n"), sourceUrl: "https://example.test/source" },
    ];
    expect(await indexSceneClientArchiveFiles(files)).toEqual(expected);
    expect(validateSceneClientArchivePaths(files.map(file => file.path))).toBeUndefined();
    expect(await indexSceneClientArchiveFiles([...files].reverse())).toEqual(expected);
    expect(files[0]!.path).toBe("资源/中文 名称.txt");
    expect(await indexSceneClientArchiveFiles([])).toEqual([]);
  });

  it("copies all contents and metadata before the first asynchronous digest", async () => {
    const laterBytes = new Uint8Array([1, 2, 3]);
    const files: SceneClientArchiveFile[] = [{ path: "a.txt", content: "first" },
      { path: "b.bin", content: laterBytes.buffer, sourceUrl: "original" }];
    const original = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (algorithm, input) => {
      laterBytes.fill(9); files[1]!.path = "mutated.bin"; files[1]!.sourceUrl = "mutated";
      files[0]!.content = "changed"; files.push({ path: "late.txt", content: "late" });
      return original(algorithm, input);
    });
    expect(await indexSceneClientArchiveFiles(files)).toEqual([
      { path: "a.txt", bytes: 5, sha256: sha("first"), sourceUrl: "generated" },
      { path: "b.bin", bytes: 3, sha256: sha(new Uint8Array([1, 2, 3])), sourceUrl: "original" },
    ]);
  });

  it.each(["", "/absolute", "C:/file", "C:file", "a\\b", "a//b", "a/", "./file", "a/./b", "../file", "a/../b",
    "a\u0000b", "a\nb", "a\u007fb", "a:stream", "a?.txt", "name.", "name ", "CON.txt", "aux/data", "manifest.json", "MANIFEST.JSON", "manifest.json/child", "MANIFEST.JSON/child"])("rejects unsafe or reserved path %j before hashing", async path => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    expect(() => validateSceneClientArchivePaths(["valid.txt", path])).toThrow(/路径/);
    await expect(indexSceneClientArchiveFiles([{ path: "valid.txt", content: "ok" }, { path, content: "bad" }])).rejects.toThrow(/路径/);
    expect(digest).not.toHaveBeenCalled();
  });

  it.each([["same.txt", "same.txt"], ["Assets/Model.bin", "assets/model.BIN"], ["a", "a/b"], ["a/b", "a"],
    ["ASSETS", "assets/model.bin"], ["assets/model.bin", "ASSETS"], ["a/b", "a/B/c"]])("rejects path collisions %j", async (first, second) => {
    expect(() => validateSceneClientArchivePaths([first!, second!])).toThrow("冲突");
    await expect(indexSceneClientArchiveFiles([{ path: first!, content: "a" }, { path: second!, content: "b" }])).rejects.toThrow("冲突");
  });

  it("rejects pre-cancellation including an empty archive before hashing", async () => {
    const controller = new AbortController(); controller.abort(); const digest = vi.spyOn(crypto.subtle, "digest");
    await expect(indexSceneClientArchiveFiles([], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(indexSceneClientArchiveFiles([{ path: "a", content: "a" }], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(digest).not.toHaveBeenCalled();
  });

  it("rejects cancellation during digest without starting the next file or returning partial indices", async () => {
    const controller = new AbortController(), original = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (algorithm, input) => {
      const value = await original(algorithm, input); controller.abort(); return value;
    });
    await expect(indexSceneClientArchiveFiles([{ path: "a", content: "a" }, { path: "b", content: "b" }], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(digest).toHaveBeenCalledTimes(1);
  });
});
