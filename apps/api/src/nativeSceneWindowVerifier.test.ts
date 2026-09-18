import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createNativeSceneWindowVerifier } from "./nativeSceneWindowVerifier.js";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
 const directory = await mkdtemp(path.join(tmpdir(), "window-adapter-")); directories.push(directory);
 const bundleDirectory = pathToFileURL(directory + path.sep);
 const source = "export async function verifySceneNativeWindow(options) { options.signal?.throwIfAborted(); return { executable: options.nativeExecutable, requestedFrames: options.frames, sourceSha256: options.packagePath }; }";
 await writeFile(path.join(directory, "window-verifier.mjs"), source);
 const manifest = { schemaVersion: 1, windowVerifierSha256: createHash("sha256").update(source).digest("hex") };
 await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
 return { directory, bundleDirectory, manifest };
}
it("uses only server-configured executable and snapshots config", async () => {
 const f = await fixture(), config = { nativeExecutable: "server.exe", frames: 3, bundleDirectory: f.bundleDirectory };
 const verify = createNativeSceneWindowVerifier(config); config.nativeExecutable = "changed.exe";
 expect(await verify("private-candidate.json")).toMatchObject({ executable: "server.exe", requestedFrames: 3, sourceSha256: "private-candidate.json" });
});
it("rejects missing or hash-mismatched deployment before importing", async () => {
 const f = await fixture(); const verify = createNativeSceneWindowVerifier({ nativeExecutable: "server.exe", bundleDirectory: f.bundleDirectory });
 f.manifest.windowVerifierSha256 = "0".repeat(64); await writeFile(path.join(f.directory, "manifest.json"), JSON.stringify(f.manifest));
 await expect(verify("candidate")).rejects.toThrow("校验失败");
 await rm(path.join(f.directory, "window-verifier.mjs")); await expect(verify("candidate")).rejects.toThrow("不可用");
});
it("propagates cancellation before module loading", async () => {
 const f = await fixture(); const verify = createNativeSceneWindowVerifier({ nativeExecutable: "server.exe", bundleDirectory: f.bundleDirectory });
 await expect(verify("candidate", AbortSignal.abort())).rejects.toThrow();
});
