import {
  assertApplicationDocument,
  type ApplicationDocument,
  type ModelFormat,
  type ModelRecord,
  type ProjectRecord,
  type PublishedApplicationRecord,
  type PublishedSceneRecord,
  type SceneSnapshot,
  type SystemUserRecord,
  type ViewerKind,
} from "@bim-studio/contracts";
import { DEFAULT_BRANDING } from "../appDefaults.js";
import {
  IndexedDbDesktopLocalWorkspaceStore,
  type DesktopLocalWorkspaceState,
  type DesktopLocalWorkspaceStore,
} from "./desktopLocalWorkspaceStore.js";
import { localDesktopApiOrigin } from "./desktopRuntimeMode.js";
import {
  badRequest,
  conflict,
  emptyResponse,
  jsonResponse,
  matchRoute,
  methodNotAllowed,
  notFound,
  serverOnly,
} from "./desktopLocalApiHttp.js";

const LOCAL_USER: SystemUserRecord = {
  id: "local-owner",
  username: "local",
  displayName: "本地开发者",
  role: "editor",
  projectIds: ["local-project"],
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const DIRECT_VIEWER_KINDS: Partial<Record<ModelFormat, ViewerKind>> = {
  ifc: "ifc",
  gltf: "gltf",
  glb: "gltf",
  fbx: "fbx",
  dxf: "dxf",
  obj: "obj",
  stl: "stl",
  "3mf": "3mf",
  dae: "dae",
  "3ds": "3ds",
  usd: "usd",
  usda: "usd",
  usdc: "usd",
  usdz: "usd",
};

export function localDesktopUser(): SystemUserRecord {
  return structuredClone(LOCAL_USER);
}

export class DesktopLocalApi {
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly modelUrls = new Map<string, string>();

  constructor(private readonly store: DesktopLocalWorkspaceStore = new IndexedDbDesktopLocalWorkspaceStore()) {}

  async handle(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, localDesktopApiOrigin());
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    try {
      if (method === "GET") return await this.read(url);
      return await this.mutate(() => this.write(method, url, init));
    } catch (error) {
      return jsonResponse({ message: error instanceof Error ? error.message : String(error) }, 500);
    }
  }

  private async read(url: URL): Promise<Response> {
    if (url.pathname === "/api/public/branding") return jsonResponse(DEFAULT_BRANDING);
    if (url.pathname === "/api/auth/me") return jsonResponse(localDesktopUser());
    if (url.pathname === "/api/meta") return jsonResponse(localMeta());
    if (url.pathname === "/api/revit/installations") return jsonResponse({ installations: [], defaultVersion: "auto" });

    const state = await this.store.read();
    if (url.pathname === "/api/projects") return jsonResponse(await this.materializeProjects(state.projects));

    const projectRoute = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)$/, 1);
    if (projectRoute) {
      const project = state.projects.find((item) => item.id === projectRoute[0]);
      return project ? jsonResponse(await this.materializeProject(project)) : notFound("项目不存在");
    }

    const collection = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/(scenes|applications)$/, 2);
    if (collection) {
      const [projectId, kind] = collection;
      if (!hasProject(state, projectId)) return notFound("项目不存在");
      return jsonResponse(kind === "scenes"
        ? state.scenes.filter((item) => item.projectId === projectId)
        : state.applications.filter((item) => item.metadata.projectId === projectId));
    }

    const applicationRoute = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/applications\/([^/]+)$/, 2);
    if (applicationRoute) {
      const application = findApplication(state, applicationRoute[0], applicationRoute[1]);
      return application ? jsonResponse(application) : notFound("应用不存在");
    }

    const sceneRoute = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/scenes\/([^/]+)$/, 2);
    if (sceneRoute) {
      const scene = findScene(state, sceneRoute[0], sceneRoute[1]);
      return scene ? jsonResponse(scene) : notFound("场景不存在");
    }

    const scenePublications = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/scenes\/([^/]+)\/publications$/, 2);
    if (scenePublications) {
      return jsonResponse(state.scenePublications.filter((item) => item.projectId === scenePublications[0] && item.sceneId === scenePublications[1]));
    }

    const publishedScene = matchRoute(url.pathname, /^\/api\/public\/scenes\/([^/]+)$/, 1);
    if (publishedScene) {
      const publication = latestScenePublication(state, publishedScene[0]);
      return publication ? jsonResponse(publication) : notFound("场景尚未发布或已删除");
    }

    const browseScene = matchRoute(url.pathname, /^\/api\/scenes\/([^/]+)\/browse$/, 1);
    if (browseScene) {
      const scene = state.scenes.find((item) => item.id === browseScene[0]);
      const project = scene && state.projects.find((item) => item.id === scene.projectId);
      return scene && project ? jsonResponse({ scene, project: await this.materializeProject(project) }) : notFound("场景不存在");
    }

    return serverOnly(url.pathname);
  }

  private async write(method: string, url: URL, init: RequestInit): Promise<Response> {
    const state = await this.store.read();
    const now = new Date().toISOString();

    if (url.pathname === "/api/projects" && method === "POST") {
      const body = await jsonBody<{ name?: string; description?: string }>(init);
      const name = body.name?.trim();
      if (!name) return badRequest("项目名称不能为空");
      const project: ProjectRecord = { id: crypto.randomUUID(), name, description: body.description?.trim() ?? "", models: [], createdAt: now, updatedAt: now };
      state.projects.push(project);
      await this.store.write(state);
      return jsonResponse(project, 201);
    }

    const projectRoute = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)$/, 1);
    if (projectRoute) return this.writeProject(state, projectRoute[0], method, init, now);

    const modelUpload = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/models$/, 1);
    if (modelUpload && method === "POST") return this.uploadModel(state, modelUpload[0], init, now);

    const modelRoute = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/models\/([^/]+)$/, 2);
    if (modelRoute) return this.writeModel(state, modelRoute[0], modelRoute[1], method, init, now);

    const applications = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/applications$/, 1);
    if (applications && method === "POST") {
      if (!hasProject(state, applications[0])) return notFound("项目不存在");
      const application = await applicationBody(init, applications[0]);
      if (state.applications.some((item) => item.metadata.id === application.metadata.id)) return conflict("应用 ID 已存在");
      state.applications.push({ ...application, metadata: { ...application.metadata, revision: 1, createdAt: now, updatedAt: now } });
      await touchAndWrite(this.store, state, applications[0], now);
      return jsonResponse(state.applications.at(-1), 201);
    }

    const applicationRoute = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/applications\/([^/]+)$/, 2);
    if (applicationRoute) return this.writeApplication(state, applicationRoute[0], applicationRoute[1], method, init, now);

    const workspaceRoute = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/applications\/([^/]+)\/workspace$/, 2);
    if (workspaceRoute && method === "PUT") return this.writeApplicationWorkspace(state, workspaceRoute[0], workspaceRoute[1], init, now);

    const applicationPublish = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/applications\/([^/]+)\/publish$/, 2);
    if (applicationPublish) return this.writeApplicationPublication(state, applicationPublish[0], applicationPublish[1], method, now);

    const sceneImport = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/scenes\/import$/, 1);
    if (sceneImport && method === "POST") {
      const source = await jsonBody<SceneSnapshot>(init);
      if (source.schemaVersion !== 1) return badRequest("场景格式无效");
      const scene = { ...source, id: crypto.randomUUID(), projectId: sceneImport[0], createdAt: now, updatedAt: now };
      delete scene.publishedAt;
      state.scenes.push(scene);
      await touchAndWrite(this.store, state, sceneImport[0], now);
      return jsonResponse(scene, 201);
    }

    const sceneCopy = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/scenes\/([^/]+)\/copy$/, 2);
    if (sceneCopy && method === "POST") return this.copyScene(state, sceneCopy[0], sceneCopy[1], init, now);

    const sceneRoute = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/scenes\/([^/]+)$/, 2);
    if (sceneRoute) return this.writeScene(state, sceneRoute[0], sceneRoute[1], method, init, now);

    const scenePublish = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/scenes\/([^/]+)\/publish$/, 2);
    if (scenePublish) return this.writeScenePublication(state, scenePublish[0], scenePublish[1], method, now);

    const restorePublication = matchRoute(url.pathname, /^\/api\/projects\/([^/]+)\/scenes\/([^/]+)\/publications\/([^/]+)\/restore$/, 3);
    if (restorePublication && method === "POST") return this.restoreScenePublication(state, restorePublication[0], restorePublication[1], restorePublication[2], now);

    return serverOnly(url.pathname);
  }

  private async writeProject(state: DesktopLocalWorkspaceState, projectId: string, method: string, init: RequestInit, now: string): Promise<Response> {
    const index = state.projects.findIndex((item) => item.id === projectId);
    if (index < 0) return notFound("项目不存在");
    if (method === "PATCH") {
      const body = await jsonBody<{ name?: string; description?: string }>(init);
      const name = body.name?.trim();
      if (!name) return badRequest("项目名称不能为空");
      state.projects[index] = { ...state.projects[index]!, name, description: body.description?.trim() ?? "", updatedAt: now };
      await this.store.write(state);
      return jsonResponse(await this.materializeProject(state.projects[index]!));
    }
    if (method === "DELETE") {
      const modelIds = state.projects[index]!.models.map((model) => model.id);
      state.projects.splice(index, 1);
      state.scenes = state.scenes.filter((item) => item.projectId !== projectId);
      state.applications = state.applications.filter((item) => item.metadata.projectId !== projectId);
      state.scenePublications = state.scenePublications.filter((item) => item.projectId !== projectId);
      state.applicationPublications = state.applicationPublications.filter((item) => item.projectId !== projectId);
      await this.store.write(state);
      await Promise.all(modelIds.map((id) => this.removeModelAsset(id)));
      return emptyResponse();
    }
    return methodNotAllowed();
  }

  private async uploadModel(state: DesktopLocalWorkspaceState, projectId: string, init: RequestInit, now: string): Promise<Response> {
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) return notFound("项目不存在");
    if (!(init.body instanceof FormData)) return badRequest("请选择模型文件");
    const file = init.body.get("file");
    if (!(file instanceof File)) return badRequest("请选择模型文件");
    const format = extension(file.name) as ModelFormat;
    const viewerKind = DIRECT_VIEWER_KINDS[format];
    if (!viewerKind) return conflict("该格式需要连接工程格式转换服务后上传");
    const id = crypto.randomUUID();
    await this.store.writeModelAsset(id, file);
    const sourceUrl = this.rememberModelUrl(id, file);
    const model: ModelRecord = {
      id,
      projectId,
      name: file.name,
      format,
      size: file.size,
      status: "ready",
      progress: 100,
      message: "本地资源已就绪",
      sourceUrl,
      manifest: {
        schemaVersion: 1,
        modelId: id,
        sourceName: file.name,
        sourceFormat: format,
        viewerKind,
        geometryUrl: sourceUrl,
        createdAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    project.models.push(model);
    project.updatedAt = now;
    await this.store.write(state);
    return jsonResponse(model, 201);
  }

  private async writeModel(state: DesktopLocalWorkspaceState, projectId: string, modelId: string, method: string, init: RequestInit, now: string): Promise<Response> {
    const project = state.projects.find((item) => item.id === projectId);
    const index = project?.models.findIndex((item) => item.id === modelId) ?? -1;
    if (!project || index < 0) return notFound("模型不存在");
    if (method === "PATCH") {
      const body = await jsonBody<{ name?: string }>(init);
      const name = body.name?.trim();
      if (!name) return badRequest("模型名称不能为空");
      project.models[index] = { ...project.models[index]!, name, updatedAt: now };
      project.updatedAt = now;
      await this.store.write(state);
      return jsonResponse(project.models[index]);
    }
    if (method === "DELETE") {
      project.models.splice(index, 1);
      project.updatedAt = now;
      await this.store.write(state);
      await this.removeModelAsset(modelId);
      return emptyResponse();
    }
    return methodNotAllowed();
  }

  private async writeApplication(state: DesktopLocalWorkspaceState, projectId: string, applicationId: string, method: string, init: RequestInit, now: string): Promise<Response> {
    const index = state.applications.findIndex((item) => item.metadata.projectId === projectId && item.metadata.id === applicationId);
    if (index < 0) return notFound("应用不存在");
    if (method === "PUT") {
      const incoming = await applicationBody(init, projectId, applicationId);
      const current = state.applications[index]!;
      const saved = { ...incoming, metadata: { ...incoming.metadata, revision: current.metadata.revision + 1, createdAt: current.metadata.createdAt, updatedAt: now } };
      state.applications[index] = saved;
      await touchAndWrite(this.store, state, projectId, now);
      return jsonResponse(saved);
    }
    if (method === "DELETE") {
      state.applications.splice(index, 1);
      state.applicationPublications = state.applicationPublications.filter((item) => item.applicationId !== applicationId);
      await touchAndWrite(this.store, state, projectId, now);
      return emptyResponse();
    }
    return methodNotAllowed();
  }

  private async writeApplicationWorkspace(state: DesktopLocalWorkspaceState, projectId: string, applicationId: string, init: RequestInit, now: string): Promise<Response> {
    const body = await jsonBody<{ application?: unknown; scene?: SceneSnapshot }>(init);
    const application = validateApplication(body.application, projectId, applicationId);
    const scene = body.scene;
    if (!scene || scene.schemaVersion !== 1) return badRequest("场景格式无效");
    const appIndex = state.applications.findIndex((item) => item.metadata.projectId === projectId && item.metadata.id === applicationId);
    if (appIndex < 0) return notFound("应用不存在");
    const sceneIndex = state.scenes.findIndex((item) => item.projectId === projectId && item.id === scene.id);
    const savedApplication = {
      ...application,
      metadata: {
        ...application.metadata,
        revision: state.applications[appIndex]!.metadata.revision + 1,
        createdAt: state.applications[appIndex]!.metadata.createdAt,
        updatedAt: now,
      },
    };
    const savedScene = { ...scene, projectId, createdAt: sceneIndex >= 0 ? state.scenes[sceneIndex]!.createdAt : scene.createdAt, updatedAt: now };
    state.applications[appIndex] = savedApplication;
    if (sceneIndex >= 0) state.scenes[sceneIndex] = savedScene;
    else state.scenes.push(savedScene);
    await touchAndWrite(this.store, state, projectId, now);
    return jsonResponse({ application: savedApplication, scene: savedScene });
  }

  private async writeApplicationPublication(state: DesktopLocalWorkspaceState, projectId: string, applicationId: string, method: string, now: string): Promise<Response> {
    const application = findApplication(state, projectId, applicationId);
    if (!application) return notFound("应用不存在");
    if (method === "POST") {
      const record: PublishedApplicationRecord = { id: crypto.randomUUID(), applicationId, projectId, applicationRevision: application.metadata.revision, document: structuredClone(application), publishedAt: now };
      state.applicationPublications.push(record);
      await this.store.write(state);
      return jsonResponse(record, 201);
    }
    if (method === "DELETE") {
      state.applicationPublications = state.applicationPublications.filter((item) => item.applicationId !== applicationId);
      await this.store.write(state);
      return emptyResponse();
    }
    return methodNotAllowed();
  }

  private async writeScene(state: DesktopLocalWorkspaceState, projectId: string, sceneId: string, method: string, init: RequestInit, now: string): Promise<Response> {
    const index = state.scenes.findIndex((item) => item.projectId === projectId && item.id === sceneId);
    if (method === "PUT") {
      const incoming = await jsonBody<SceneSnapshot>(init);
      if (incoming.schemaVersion !== 1) return badRequest("场景格式无效");
      const existing = index >= 0 ? state.scenes[index] : undefined;
      const scene = { ...incoming, id: sceneId, projectId, createdAt: existing?.createdAt ?? now, updatedAt: now };
      if (index >= 0) state.scenes[index] = scene;
      else state.scenes.push(scene);
      await touchAndWrite(this.store, state, projectId, now);
      return jsonResponse(scene);
    }
    if (index < 0) return notFound("场景不存在");
    if (method === "PATCH") {
      const body = await jsonBody<{ name?: string }>(init);
      const name = body.name?.trim();
      if (!name) return badRequest("场景名称不能为空");
      state.scenes[index] = { ...state.scenes[index]!, name, updatedAt: now };
      await touchAndWrite(this.store, state, projectId, now);
      return jsonResponse(state.scenes[index]);
    }
    if (method === "DELETE") {
      state.scenes.splice(index, 1);
      state.scenePublications = state.scenePublications.filter((item) => item.sceneId !== sceneId);
      await touchAndWrite(this.store, state, projectId, now);
      return emptyResponse();
    }
    return methodNotAllowed();
  }

  private async copyScene(state: DesktopLocalWorkspaceState, projectId: string, sceneId: string, init: RequestInit, now: string): Promise<Response> {
    const source = findScene(state, projectId, sceneId);
    if (!source) return notFound("场景不存在");
    const body = await jsonBody<{ name?: string }>(init);
    const copy = { ...structuredClone(source), id: crypto.randomUUID(), name: body.name?.trim() || `${source.name} - 副本`, createdAt: now, updatedAt: now };
    delete copy.publishedAt;
    state.scenes.push(copy);
    await touchAndWrite(this.store, state, projectId, now);
    return jsonResponse(copy, 201);
  }

  private async writeScenePublication(state: DesktopLocalWorkspaceState, projectId: string, sceneId: string, method: string, now: string): Promise<Response> {
    const index = state.scenes.findIndex((item) => item.projectId === projectId && item.id === sceneId);
    if (index < 0) return notFound("场景不存在");
    if (method === "POST") {
      const snapshot = { ...state.scenes[index]!, publishedAt: now, updatedAt: now };
      state.scenes[index] = snapshot;
      const record: PublishedSceneRecord = { sceneId, projectId, name: snapshot.name, snapshot: structuredClone(snapshot), publishedAt: now, version: state.scenePublications.filter((item) => item.sceneId === sceneId).length + 1 };
      state.scenePublications.push(record);
      await this.store.write(state);
      return jsonResponse(record, 201);
    }
    if (method === "DELETE") {
      state.scenePublications = state.scenePublications.filter((item) => item.sceneId !== sceneId);
      delete state.scenes[index]!.publishedAt;
      await this.store.write(state);
      return emptyResponse();
    }
    return methodNotAllowed();
  }

  private async restoreScenePublication(state: DesktopLocalWorkspaceState, projectId: string, sceneId: string, encodedPublishedAt: string, now: string): Promise<Response> {
    const historical = state.scenePublications.find((item) => item.projectId === projectId && item.sceneId === sceneId && item.publishedAt === decodeURIComponent(encodedPublishedAt));
    const scene = findScene(state, projectId, sceneId);
    if (!scene) return notFound("场景不存在");
    if (!historical) return notFound("发布版本不存在");
    const record = { ...structuredClone(historical), snapshot: { ...structuredClone(historical.snapshot), publishedAt: now, updatedAt: now }, publishedAt: now };
    state.scenePublications.push(record);
    scene.publishedAt = now;
    scene.publicationMode = record.snapshot.publicationMode ?? "webgl";
    scene.publicationPerformance = record.snapshot.publicationPerformance ?? "standard";
    scene.publicationToolbarVisible = record.snapshot.publicationToolbarVisible !== false;
    await this.store.write(state);
    return jsonResponse(record, 201);
  }

  private async materializeProjects(projects: ProjectRecord[]): Promise<ProjectRecord[]> {
    return Promise.all(projects.map((project) => this.materializeProject(project)));
  }

  private async materializeProject(project: ProjectRecord): Promise<ProjectRecord> {
    const copy = structuredClone(project);
    copy.models = await Promise.all(copy.models.map(async (model) => {
      const asset = await this.store.readModelAsset(model.id);
      if (!asset) return model;
      const sourceUrl = this.rememberModelUrl(model.id, asset);
      return {
        ...model,
        sourceUrl,
        ...(model.manifest ? { manifest: { ...model.manifest, geometryUrl: sourceUrl } } : {}),
      };
    }));
    return copy;
  }

  private rememberModelUrl(modelId: string, asset: Blob): string {
    const existing = this.modelUrls.get(modelId);
    if (existing) return existing;
    const url = URL.createObjectURL(asset);
    this.modelUrls.set(modelId, url);
    return url;
  }

  private async removeModelAsset(modelId: string): Promise<void> {
    await this.store.deleteModelAsset(modelId);
    const url = this.modelUrls.get(modelId);
    if (url) URL.revokeObjectURL(url);
    this.modelUrls.delete(modelId);
  }

  private async mutate(run: () => Promise<Response>): Promise<Response> {
    let release!: () => void;
    const previous = this.mutationQueue;
    this.mutationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await run(); }
    finally { release(); }
  }
}

const localApi = new DesktopLocalApi();

export function desktopLocalApiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return localApi.handle(input, init);
}

function localMeta() {
  return {
    serverInstanceId: "desktop-local",
    apiVersion: "1.0" as const,
    serverTime: new Date().toISOString(),
    capabilities: {
      applications: { schemaVersions: [2] as [2], immutablePublications: true },
      legacyScenes: { schemaVersions: [1] as [1], routes: true },
      authentication: { providers: ["local"] as ["local"] },
      hosts: { browser: false, tauri: true },
    },
  };
}

function validateApplication(value: unknown, projectId: string, applicationId?: string): ApplicationDocument {
  assertApplicationDocument(value);
  if (value.metadata.projectId !== projectId || (applicationId && value.metadata.id !== applicationId)) throw new Error("应用身份与请求路径不一致");
  return structuredClone(value);
}

async function applicationBody(init: RequestInit, projectId: string, applicationId?: string): Promise<ApplicationDocument> {
  return validateApplication(await jsonBody(init), projectId, applicationId);
}

async function jsonBody<T>(init: RequestInit): Promise<T> {
  if (typeof init.body !== "string") throw new Error("本地 API 只接受 JSON 请求体");
  return JSON.parse(init.body) as T;
}

async function touchAndWrite(store: DesktopLocalWorkspaceStore, state: DesktopLocalWorkspaceState, projectId: string, now: string): Promise<void> {
  const project = state.projects.find((item) => item.id === projectId);
  if (project) project.updatedAt = now;
  await store.write(state);
}

function hasProject(state: DesktopLocalWorkspaceState, projectId: string): boolean {
  return state.projects.some((item) => item.id === projectId);
}

function findApplication(state: DesktopLocalWorkspaceState, projectId: string, applicationId: string): ApplicationDocument | undefined {
  return state.applications.find((item) => item.metadata.projectId === projectId && item.metadata.id === applicationId);
}

function findScene(state: DesktopLocalWorkspaceState, projectId: string, sceneId: string): SceneSnapshot | undefined {
  return state.scenes.find((item) => item.projectId === projectId && item.id === sceneId);
}

function latestScenePublication(state: DesktopLocalWorkspaceState, sceneId: string): PublishedSceneRecord | undefined {
  return state.scenePublications.filter((item) => item.sceneId === sceneId).sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))[0];
}

function extension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}
