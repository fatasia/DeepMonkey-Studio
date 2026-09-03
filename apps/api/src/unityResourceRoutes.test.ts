import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import multipart from "@fastify/multipart";
import { afterEach, describe, expect, it } from "vitest";
import { LocalObjectStore } from "./objects.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";
import { extractUnityZip, registerUnityResourceRoutes, safeArchivePath } from "./unityResourceRoutes.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Unity resource import", () => {
  it("unwraps a Unity build folder and discovers the manifest", async () => {
    const zip = new JSZip();
    zip.file("Build/index.html", "<!doctype html>");
    zip.file("Build/Build.loader.js", "console.log('loader')");
    zip.file("Build/Build.framework.js.br", "framework");
    zip.file("Build/Build.wasm.br", "wasm");
    zip.file("Build/Build.data.br", "data");
    zip.file(
      "Build/bim-studio.manifest.json",
      JSON.stringify({
        schemaVersion: 1,
        bridgeVersion: 1,
        unityVersion: "2022.3",
        bridgePackageVersion: "0.6.1",
        scenes: ["Factory"],
        events: ["device-click"],
        dataLayers: [{ key: "temperature" }],
        runtimeCapabilities: ["ack", "heartbeat", "unknown-capability"],
      }),
    );
    const target = await mkdtemp(path.join(tmpdir(), "bim-unity-test-"));
    temporaryDirectories.push(target);

    const result = await extractUnityZip(await zip.generateAsync({ type: "nodebuffer" }), target);

    expect(result.playerPath).toBe("index.html");
    expect(result.manifest.unityVersion).toBe("2022.3");
    expect(result.manifest.bridgePackageVersion).toBe("0.6.1");
    expect(result.manifest.webBuild).toMatchObject({ compression: "brotli", runtimeFileCount: 4 });
    expect(result.manifest.scenes).toEqual(["Factory"]);
    expect(result.manifest.events).toEqual(["device-click"]);
    expect(result.manifest.runtimeCapabilities).toEqual(["ack", "heartbeat"]);
    expect(await readFile(path.join(target, "index.html"), "utf8")).toContain("doctype");
  });

  it("rejects archive traversal paths before extraction", () => {
    expect(() => safeArchivePath("../index.html")).toThrow("不安全路径");
    expect(() => safeArchivePath("C:/temp/index.html")).toThrow("不安全路径");
  });

  it("reuses an identical build instead of creating a fake new version", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-unity-routes-"));
    temporaryDirectories.push(directory);
    const store = new JsonStore(directory);
    await store.init();
    const app = createApiServer();
    await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
    await registerUnityResourceRoutes(app, { store, objects: new LocalObjectStore(directory), dataDir: directory });

    const zip = new JSZip();
    zip.file("Build/index.html", "<!doctype html>");
    zip.file("Build/Build.loader.js", "loader");
    zip.file("Build/Build.framework.js.gz", "framework");
    zip.file("Build/Build.wasm.gz", "wasm");
    zip.file("Build/Build.data.gz", "data");
    zip.file("Build/bim-studio.manifest.json", JSON.stringify({ schemaVersion: 1, bridgeVersion: 1, bridgePackageVersion: "0.6.1", unityVersion: "2022.3.62f1", scenes: ["Factory"], events: ["device-click"] }));
    const archive = await zip.generateAsync({ type: "nodebuffer" });
    const first = await app.inject({ method: "POST", url: "/api/projects/default/unity-resources?name=Factory", ...multipartPayload(archive, "factory.zip") });
    expect(first.statusCode).toBe(201);
    const resourceId = first.json().id as string;

    const duplicate = await app.inject({ method: "POST", url: `/api/projects/default/unity-resources?resourceId=${resourceId}&name=Factory`, ...multipartPayload(archive, "factory.zip") });

    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.headers["x-bim-unity-deduplicated"]).toBe("true");
    expect(duplicate.json().versions).toHaveLength(1);
    expect(duplicate.json().activeVersionId).toBe(first.json().activeVersionId);
    await app.close();
  });
});

function multipartPayload(file: Buffer, filename: string): { headers: Record<string, string>; payload: Buffer } {
  const boundary = `bim-studio-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([head, file, tail]) };
}
