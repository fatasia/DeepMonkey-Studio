import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { LocalObjectStore } from "./objects.js";
import { registerRoutes } from "./routes.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("Unity compressed asset delivery", () => {
  it.each([
    ["player.wasm.br", "br", "application/wasm"],
    ["player.framework.js.gz", "gzip", "text/javascript"],
  ])("serves %s with its original encoding and MIME", async (fileName, encoding, mime) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bim-unity-delivery-"));
    temporaryDirectories.push(dataDir);
    const key = `projects/default/unity/resource/version/Build/${fileName}`;
    const filePath = path.join(dataDir, ...key.split("/"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from([1, 2, 3]));
    const store = new JsonStore(dataDir);
    await store.init();
    const app = createApiServer();
    await registerRoutes(app, {
      store,
      queue: undefined as never,
      objects: new LocalObjectStore(dataDir),
      dataDir,
      config: loadConfig(),
    });

    const response = await app.inject({ method: "GET", url: `/assets/${key}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe(encoding);
    expect(response.headers["content-type"]).toContain(mime);
    expect(response.headers["cache-control"]).toContain("immutable");
    await app.close();
  });
});
