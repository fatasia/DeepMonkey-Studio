import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { migrateSceneSnapshotV1, type ApplicationDocument, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { createProjectTransfer, sanitizeTransferUrl } from "../src/delivery/projectTransferModel.ts";
import { ProjectTransferImport } from "../src/delivery/projectTransferImport.ts";
import { readProjectTransfer, transferSha256, type ProjectTransferArchive } from "../src/delivery/projectTransferArchive.ts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const apiRoot = path.join(repositoryRoot, "apps/api");
const outputRoot = path.join(repositoryRoot, "test-output/project-transfer-storage-parity");
const fixturePath = path.join(repositoryRoot, "test-fixtures/scene-v1-dashboard.json");
const modelPath = path.join(repositoryRoot, "packages/deep-engine/lab/assets/Box.glb");
const requireFromApi = createRequire(path.join(apiRoot, "package.json"));
const tsxCli = requireFromApi.resolve("tsx/cli");
const workspace = await mkdtemp(path.join(tmpdir(), "deep-monkey-project-transfer-"));
const localToken = `desktop-local-${randomUUID()}-${randomUUID()}`;
const children: ChildProcess[] = [];
const serverProjects: string[] = [];
let serverForCleanup: TransferHttpApi | undefined;

try {
  const [localPort, serverPort] = await Promise.all([freePort(), freePort()]);
  children.push(startApi(localPort, {
    NODE_ENV: "development",
    BIM_STUDIO_DEPLOYMENT_MODE: "desktop-local",
    BIM_STUDIO_DESKTOP_LOCAL_TOKEN: localToken,
    BIM_STUDIO_SESSION_SECRET: `${localToken}-session-secret`,
    BIM_STUDIO_ADMIN_PASSWORD: `${localToken}-admin-password`,
    METADATA_STORE: "sqlite",
    SQLITE_DATABASE: path.join(workspace, "metadata.sqlite"),
    OBJECT_STORE: "local",
    DATA_DIR: path.join(workspace, "data"),
  }));
  children.push(startApi(serverPort, {
    NODE_ENV: "development",
    BIM_STUDIO_DEPLOYMENT_MODE: "server",
    METADATA_STORE: "postgres",
    OBJECT_STORE: "minio",
  }));
  await Promise.all(children.map((child, index) => waitForHealth(index === 0 ? localPort : serverPort, child)));

  const local = createHttpTransferApi(`http://127.0.0.1:${localPort}`, localToken);
  const serverPassword = await readEnvironmentValue("BIM_STUDIO_ADMIN_PASSWORD");
  const serverToken = await login(`http://127.0.0.1:${serverPort}`, serverPassword);
  const server = createHttpTransferApi(`http://127.0.0.1:${serverPort}`, serverToken);
  serverForCleanup = server;

  const sourceProject = await createRealFixture(local);
  const localArchive = await exportArchive(local, sourceProject.id);
  assertSanitized(localArchive);
  const serverProject = await new ProjectTransferImport(localArchive, server.importApi)
    .run(`PostgreSQL roundtrip ${Date.now()}`, new AbortController().signal, () => undefined);
  serverProjects.push(serverProject.id);
  const serverArchive = await exportArchive(server, serverProject.id);
  assertSanitized(serverArchive);
  const localRoundtrip = await new ProjectTransferImport(serverArchive, local.importApi)
    .run(`SQLite return ${Date.now()}`, new AbortController().signal, () => undefined);

  const sourceClosure = closure(localArchive);
  const serverClosure = closure(serverArchive);
  const stableResources = (value: ReturnType<typeof closure>) => value.files
    .filter((file) => !file.name.toLowerCase().endsWith(".glb")).map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
  if (JSON.stringify(stableResources(sourceClosure)) !== JSON.stringify(stableResources(serverClosure))) {
    throw new Error(`Non-model resource closure changed across stores: ${JSON.stringify({ sourceClosure, serverClosure })}`);
  }
  for (const value of [sourceClosure, serverClosure]) {
    if (value.models !== 1 || value.assets !== 1 || value.dependencies !== 1 || value.connections !== 2
      || value.datasets !== 2 || value.pipelines !== 1 || value.scenes !== 1 || value.applications !== 1) {
      throw new Error(`Unexpected project closure: ${JSON.stringify(value)}`);
    }
  }
  await assertImportedBindings(server, serverProject.id);
  await assertImportedBindings(local, localRoundtrip.id);

  await mkdir(outputRoot, { recursive: true });
  const localBytes = await packArchive(localArchive);
  const serverBytes = await packArchive(serverArchive);
  await writeFile(path.join(outputRoot, "sqlite-source.bimproject"), localBytes);
  await writeFile(path.join(outputRoot, "postgres-roundtrip.bimproject"), serverBytes);
  const result = {
    ok: true,
    stores: ["sqlite/local", "postgres/minio"],
    direction: "sqlite -> postgres -> sqlite",
    sourceClosure,
    serverClosure,
    archives: {
      sqlite: { bytes: localBytes.length, sha256: await transferSha256(toArrayBuffer(localBytes)) },
      postgres: { bytes: serverBytes.length, sha256: await transferSha256(toArrayBuffer(serverBytes)) },
    },
    modelContentStable: sourceClosure.files.find((file) => file.name.toLowerCase().endsWith(".glb"))?.sha256
      === serverClosure.files.find((file) => file.name.toLowerCase().endsWith(".glb"))?.sha256,
    credentialsPresent: false,
    sourceProjectId: sourceProject.id,
    serverProjectId: serverProject.id,
    returnedProjectId: localRoundtrip.id,
  };
  await writeFile(path.join(outputRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Project transfer storage parity passed: ${JSON.stringify(result)}`);
} finally {
  if (serverForCleanup) for (const id of serverProjects.reverse()) await serverForCleanup.deleteProject(id).catch(() => undefined);
  await Promise.all(children.map(stopChild));
  await rm(workspace, { recursive: true, force: true });
}

type TransferHttpApi = ReturnType<typeof createHttpTransferApi>;

function createHttpTransferApi(baseUrl: string, token: string) {
  const request = async <T>(url: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(new URL(url, baseUrl), { ...init, headers });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${url}: HTTP ${response.status} ${await response.text()}`);
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  };
  const upload = <T>(url: string, fields: Array<[string, string | Blob]>) => {
    const body = new FormData();
    for (const [name, value] of fields) body.append(name, value);
    return request<T>(url, { method: "POST", body });
  };
  const api = {
    createProject: (name: string, description = "") => request<ProjectRecord>("/api/projects", json("POST", { name, description })),
    deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
    getProject: (id: string) => request<ProjectRecord>(`/api/projects/${id}`),
    uploadModel: (id: string, file: File, _mode?: unknown, _version?: unknown, _generation?: unknown, robotEntryPath?: string) =>
      upload<ProjectRecord["models"][number]>(`/api/projects/${id}/models`, [...(robotEntryPath ? [["robotEntryPath", robotEntryPath] as [string, string]] : []), ["file", file]]),
    renameModel: (projectId: string, modelId: string, name: string) =>
      request(`/api/projects/${projectId}/models/${modelId}`, json("PATCH", { name })),
    uploadImageAsset: (id: string, file: File) => upload<any>(`/api/projects/${id}/assets/images`, [["file", file]]),
    uploadVideoAsset: (id: string, file: File) => upload<any>(`/api/projects/${id}/assets/videos`, [["file", file]]),
    uploadEnvironmentMap: (id: string, file: File) => upload<any>(`/api/projects/${id}/environment-maps`, [["file", file]]),
    uploadMaterialAsset: (id: string, maps: Record<string, File>) => upload<any>(`/api/projects/${id}/assets/materials`, Object.entries(maps)),
    renameAsset: (projectId: string, assetId: string, name: string) =>
      request(`/api/projects/${projectId}/assets/${assetId}`, json("PATCH", { name })),
    uploadScriptDependency: (id: string, specifier: string, file: File, options: { prepared?: boolean } = {}) =>
      upload<any>(`/api/projects/${id}/script-dependencies/upload?specifier=${encodeURIComponent(specifier)}${options.prepared ? "&prepared=1" : ""}`, [["file", file]]),
    createDataConnection: (id: string, value: unknown) => request<any>(`/api/projects/${id}/data-connections`, json("POST", value)),
    createDataset: (id: string, value: unknown) => request<any>(`/api/projects/${id}/datasets`, json("POST", value)),
    saveDataPipeline: (id: string, value: unknown) => request<any>(`/api/projects/${id}/data-pipelines`, json("POST", value)),
    saveScene: (scene: SceneSnapshot) => request<SceneSnapshot>(`/api/projects/${scene.projectId}/scenes/${scene.id}`, json("PUT", scene)),
    listScenes: (id: string) => request<SceneSnapshot[]>(`/api/projects/${id}/scenes`),
    getApplication: (projectId: string, applicationId: string) => request<ApplicationDocument>(`/api/projects/${projectId}/applications/${applicationId}`),
    listApplications: (id: string) => request<ApplicationDocument[]>(`/api/projects/${id}/applications`),
    createApplication: (document: ApplicationDocument) => request<ApplicationDocument>(`/api/projects/${document.metadata.projectId}/applications`, json("POST", document)),
    saveApplication: (document: ApplicationDocument) => request<ApplicationDocument>(`/api/projects/${document.metadata.projectId}/applications/${document.metadata.id}`, json("PUT", document)),
  };
  return {
    baseUrl,
    request,
    ...api,
    importApi: api as unknown as ConstructorParameters<typeof ProjectTransferImport>[1],
    open: async (url: string) => {
      const response = await fetch(new URL(url, baseUrl), { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
      return response;
    },
  };
}

async function createRealFixture(client: TransferHttpApi): Promise<ProjectRecord> {
  const project = await client.createProject(`Transfer parity ${Date.now()}`, "Real GLB, asset, script and data binding fixture");
  const modelBytes = await readFile(modelPath);
  const model = await client.uploadModel(project.id, new File([modelBytes], "Box.glb", { type: "model/gltf-binary" }));
  await waitForModel(client, project.id, model.id);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/69fGAAAAAElFTkSuQmCC", "base64");
  await client.uploadImageAsset(project.id, new File([png], "process.png", { type: "image/png" }));
  const dependency = await client.uploadScriptDependency(project.id, "@parity/telemetry",
    new File(["export const scale = (value) => value * 1.25;\n"], "telemetry.mjs", { type: "text/javascript" }));
  const simulation = await client.createDataConnection(project.id, { name: "Deterministic telemetry", type: "simulation", enabled: true,
    config: { url: "sim://telemetry?rows=8&seed=17&interval=500&token=must-strip", password: "must-strip" } });
  const postgres = await client.createDataConnection(project.id, { name: "Production historian", type: "postgresql", enabled: true,
    config: { host: "private.invalid", database: "plant", user: "operator", password: "must-strip", headers: { authorization: "must-strip" } } });
  const telemetry = await client.createDataset(project.id, { name: "Telemetry", connectionId: simulation.id, refreshSeconds: 1,
    sourceKey: "telemetry", fields: [{ key: "temperature", label: "Temperature", type: "number", unit: "°C" }] });
  await client.createDataset(project.id, { name: "Historian description", connectionId: postgres.id, refreshSeconds: 30,
    query: "select temperature from telemetry", fields: [{ key: "temperature", label: "Temperature", type: "number", unit: "°C" }] });
  await client.saveDataPipeline(project.id, { name: "Temperature output",
    nodes: [{ id: "source", type: "source", name: "Telemetry", datasetId: telemetry.id, position: { x: 0, y: 0 } },
      { id: "output", type: "output", name: "Output", position: { x: 220, y: 0 } }],
    edges: [{ id: "source-output", sourceNodeId: "source", targetNodeId: "output" }] });
  const scene = JSON.parse(await readFile(fixturePath, "utf8")) as SceneSnapshot;
  scene.id = `transfer-${randomUUID()}`;
  scene.projectId = project.id;
  scene.name = "Transfer parity scene";
  scene.models = [{ modelId: "box-instance", assetModelId: model.id, name: "Box", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }];
  if (scene.dashboard?.widgets[0]) scene.dashboard.widgets[0].datasetId = telemetry.id;
  delete scene.publishedAt;
  scene.createdAt = scene.updatedAt = new Date().toISOString();
  await client.saveScene(scene);
  const application = migrateSceneSnapshotV1(scene);
  application.metadata.id = `application-${randomUUID()}`;
  application.metadata.name = "Transfer parity application";
  application.scriptDependencies = [dependency];
  await client.createApplication(application);
  return await client.getProject(project.id);
}

async function exportArchive(client: TransferHttpApi, projectId: string): Promise<ProjectTransferArchive> {
  const [project, scenes, applications] = await Promise.all([
    client.getProject(projectId), client.listScenes(projectId), client.listApplications(projectId),
  ]);
  const document = createProjectTransfer(project, scenes, applications);
  const files = new Map<string, File>();
  for (const descriptor of document.files) {
    if (!descriptor.sourceUrl) throw new Error(`Missing source URL for ${descriptor.name}`);
    const bytes = await (await client.open(descriptor.sourceUrl)).arrayBuffer();
    descriptor.bytes = bytes.byteLength;
    descriptor.sha256 = await transferSha256(bytes);
    descriptor.sourceUrl = sanitizeTransferUrl(descriptor.sourceUrl);
    files.set(descriptor.id, new File([bytes], descriptor.name));
  }
  const packed = await packArchive({ document, files });
  return await readProjectTransfer(new File([packed], `${projectId}.bimproject`, { type: "application/zip" }));
}

async function packArchive(archive: ProjectTransferArchive): Promise<Buffer> {
  const zip = new JSZip();
  for (const descriptor of archive.document.files) zip.file(descriptor.path, await archive.files.get(descriptor.id)!.arrayBuffer());
  zip.file("project.json", JSON.stringify(archive.document, null, 2));
  return await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

function closure(archive: ProjectTransferArchive) {
  return {
    models: archive.document.models.length,
    assets: archive.document.assets.length,
    dependencies: archive.document.dependencies.length,
    connections: archive.document.runtime.connections.length,
    datasets: archive.document.runtime.datasets.length,
    pipelines: archive.document.runtime.pipelines.length,
    scenes: archive.document.scenes.length,
    applications: archive.document.applications.length,
    files: archive.document.files.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function assertSanitized(archive: ProjectTransferArchive): void {
  const text = JSON.stringify(archive.document);
  if (/must-strip|private\.invalid|operator|authorization/i.test(text)) throw new Error("Credential material leaked into .bimproject");
  const simulation = archive.document.runtime.connections.find((item) => item.type === "simulation");
  const postgres = archive.document.runtime.connections.find((item) => item.type === "postgresql");
  if (!simulation?.enabled || simulation.config.url !== "sim://telemetry?rows=8&seed=17&interval=500") {
    throw new Error(`Simulation configuration was not safely preserved: ${JSON.stringify(simulation)}`);
  }
  if (postgres?.enabled || Object.keys(postgres?.config ?? {}).length) throw new Error("External connection was not disabled and stripped");
}

async function assertImportedBindings(client: TransferHttpApi, projectId: string): Promise<void> {
  const [project, scenes, applications] = await Promise.all([
    client.getProject(projectId), client.listScenes(projectId), client.listApplications(projectId),
  ]);
  const datasetIds = new Set(project.datasets?.map((item) => item.id));
  const boundDataset = scenes[0]?.dashboard?.widgets[0]?.datasetId;
  if (!boundDataset || !datasetIds.has(boundDataset)) throw new Error("Scene dataset binding was not remapped into the target project");
  if (scenes[0]?.models[0]?.assetModelId !== project.models[0]?.id) throw new Error("Scene model binding was not remapped");
  if (applications[0]?.scriptDependencies?.length !== 1) throw new Error("Application script dependency was not imported");
}

function startApi(port: number, overrides: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [tsxCli, "src/index.ts", `--port=${port}`], {
    cwd: apiRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, API_HOST: "127.0.0.1", API_PORT: String(port), WEB_ORIGIN: "http://127.0.0.1", ...overrides },
  });
  const errors: Buffer[] = [];
  child.stderr?.on("data", (bytes: Buffer) => { if (errors.reduce((sum, item) => sum + item.length, 0) < 64 * 1024) errors.push(bytes); });
  Object.assign(child, { capturedErrors: errors });
  return child;
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API ${port} exited ${child.exitCode}: ${Buffer.concat((child as any).capturedErrors ?? []).toString("utf8")}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`API ${port} health timeout`);
}

async function login(baseUrl: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, json("POST", { username: "admin", password, remember: false }));
  if (!response.ok) throw new Error(`Server-mode admin login failed: HTTP ${response.status}`);
  return String((await response.json() as { token: string }).token);
}

async function readEnvironmentValue(name: string): Promise<string> {
  const line = (await readFile(path.join(repositoryRoot, ".env"), "utf8")).split(/\r?\n/)
    .find((item) => item.trimStart().startsWith(`${name}=`));
  const value = line?.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function waitForModel(client: TransferHttpApi, projectId: string, modelId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const model = (await client.getProject(projectId)).models.find((item) => item.id === modelId);
    if (model?.status === "ready") return;
    if (model?.status === "failed") throw new Error(model.message ?? "GLB import failed");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("GLB import did not become ready");
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
