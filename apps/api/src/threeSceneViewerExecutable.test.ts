import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { buildThreeSceneViewerExecutable, inspectThreeSceneArchive } from "./threeSceneViewerExecutable.js";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it("appends a verified readonly payload to a fixed launcher without compiling", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "three-launcher-test-"));
  temporaryDirectories.push(directory);
  const launcherPath = path.join(directory, "launcher.exe");
  const launcher = fakePe();
  await writeFile(launcherPath, launcher);
  const archive = await sceneArchive();

  const executable = await buildThreeSceneViewerExecutable({ launcherExecutable: launcherPath }, archive,
    new AbortController().signal);
  expect(executable.subarray(0, launcher.length)).toEqual(launcher);
  expect(executable.subarray(-48, -40).toString("ascii")).toBe("DMTHREE1");
  const payloadLength = Number(executable.readBigUInt64LE(executable.length - 40));
  const payload = executable.subarray(executable.length - 48 - payloadLength, executable.length - 48);
  expect(createHash("sha256").update(payload).digest()).toEqual(executable.subarray(-32));
  const headerLength = payload.readUInt32LE(0);
  const header = JSON.parse(payload.subarray(4, 4 + headerLength).toString("utf8")) as {
    schema: string;
    productName: string;
    files: Array<{ path: string; offset: number; bytes: number; sha256: string }>;
  };
  expect(header).toMatchObject({ schema: "deep-monkey.three-scene-viewer-payload", productName: "DeepMonkey Studio" });
  expect(header.files.map(file => file.path)).toEqual(["delivery/scene-viewer.json", "delivery/assets/machine.glb"]);
  const manifestFile = header.files[0]!;
  const contentOffset = 4 + headerLength;
  const deliveryManifest = JSON.parse(payload.subarray(contentOffset + manifestFile.offset,
    contentOffset + manifestFile.offset + manifestFile.bytes).toString("utf8"));
  expect(deliveryManifest).toMatchObject({ deliveryTarget: "windows-scene-viewer", toolbarVisible: true,
    publication: { sceneId: "scene-1", snapshot: { models: [{ url: "/delivery/assets/machine.glb" }] } } });
});

it("rejects a client package whose indexed file hash was altered", async () => {
  const archive = await sceneArchive({ corruptSceneHash: true });
  await expect(inspectThreeSceneArchive(archive)).rejects.toThrow("file hash mismatch: scene.json");
});

async function sceneArchive(options: { corruptSceneHash?: boolean } = {}): Promise<Buffer> {
  const files = new Map<string, Buffer>([
    ["scene.json", Buffer.from(JSON.stringify({ id: "scene-1", projectId: "project-1", publishedAt: "2026-09-24T00:00:00.000Z",
      models: [{ url: "assets/machine.glb" }] }))],
    ["project.json", Buffer.from(JSON.stringify({ id: "project-1", name: "Factory", description: "", models: [] }))],
    ["applications.json", Buffer.from("[]")],
    ["runtime.json", Buffer.from(JSON.stringify({ connections: [], datasets: [], pipelines: [], policy: "credentials-external",
      reconfigureConnectionIds: [] }))],
    ["README.txt", Buffer.from("readonly")],
    ["assets/machine.glb", Buffer.from("glTF-test")],
  ]);
  const descriptors = [...files].map(([filePath, bytes]) => ({ path: filePath, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), sourceUrl: filePath }));
  if (options.corruptSceneHash) descriptors.find(file => file.path === "scene.json")!.sha256 = "0".repeat(64);
  const metadata = {
    kind: "bim-studio-scene-client-package", schemaVersion: 1, purpose: "delivery", target: "three-webview",
    renderer: "webgl", toolbarVisible: true, projectId: "project-1", sceneId: "scene-1", sceneName: "Factory A",
    publishedAt: "2026-09-24T00:00:00.000Z",
  };
  const manifest = { ...metadata, generatedAt: "2026-09-24T00:00:00.000Z", files: descriptors,
    contentHash: { algorithm: "sha256", value: runtimeContentSha256({ metadata, files: descriptors.map(({ path, bytes, sha256 }) =>
      ({ path, bytes, sha256 })) }) } };
  const zip = new JSZip();
  for (const [filePath, bytes] of files) zip.file(filePath, bytes);
  zip.file("manifest.json", JSON.stringify(manifest));
  return zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

function fakePe(): Buffer {
  const bytes = Buffer.alloc(96);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(0x010f, 64 + 22);
  return bytes;
}
