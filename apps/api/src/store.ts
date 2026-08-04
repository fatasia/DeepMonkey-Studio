import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseDocument, ModelRecord, ProjectRecord, PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { AppConfig } from "./config.js";

export interface MetadataStore {
  init(): Promise<void>;
  listProjects(): ProjectRecord[];
  getProject(projectId: string): ProjectRecord | undefined;
  createProject(name: string, description?: string): Promise<ProjectRecord>;
  updateProject(projectId: string, updates: Pick<Partial<ProjectRecord>, "name" | "description">): Promise<ProjectRecord>;
  removeProject(projectId: string): Promise<boolean>;
  addModel(projectId: string, model: ModelRecord): Promise<void>;
  updateModel(projectId: string, modelId: string, updates: Partial<ModelRecord>): Promise<ModelRecord>;
  removeModel(projectId: string, modelId: string): Promise<boolean>;
  listScenes(projectId: string): SceneSnapshot[];
  getScene(projectId: string, sceneId: string): SceneSnapshot | undefined;
  getSceneById(sceneId: string): SceneSnapshot | undefined;
  saveScene(scene: SceneSnapshot): Promise<SceneSnapshot>;
  removeScene(projectId: string, sceneId: string): Promise<boolean>;
  getPublication(sceneId: string): PublishedSceneRecord | undefined;
  savePublication(publication: PublishedSceneRecord): Promise<PublishedSceneRecord>;
  removePublication(sceneId: string): Promise<boolean>;
}

export class JsonStore implements MetadataStore {
  protected readonly databasePath: string;
  protected document: DatabaseDocument = { projects: [], scenes: [] };
  private writeChain = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.databasePath = path.join(dataDir, "database.json");
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      this.document = JSON.parse(await readFile(this.databasePath, "utf8")) as DatabaseDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.document = defaultDocument();
      await this.persist();
    }
    this.document.publishedScenes ??= [];
  }

  listProjects(): ProjectRecord[] {
    return structuredClone(this.document.projects);
  }

  getProject(projectId: string): ProjectRecord | undefined {
    const project = this.document.projects.find((item) => item.id === projectId);
    return project ? structuredClone(project) : undefined;
  }

  async createProject(name: string, description = ""): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: randomUUID(),
      name,
      description,
      models: [],
      createdAt: now,
      updatedAt: now
    };
    this.document.projects.push(project);
    await this.persist();
    return structuredClone(project);
  }

  async updateProject(projectId: string, updates: Pick<Partial<ProjectRecord>, "name" | "description">): Promise<ProjectRecord> {
    const project = this.requireProject(projectId);
    if (updates.name !== undefined) project.name = updates.name;
    if (updates.description !== undefined) project.description = updates.description;
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(project);
  }

  async removeProject(projectId: string): Promise<boolean> {
    const originalLength = this.document.projects.length;
    this.document.projects = this.document.projects.filter((item) => item.id !== projectId);
    if (this.document.projects.length === originalLength) return false;
    this.document.scenes = this.document.scenes.filter((scene) => scene.projectId !== projectId);
    this.document.publishedScenes = (this.document.publishedScenes ?? []).filter((scene) => scene.projectId !== projectId);
    await this.persist();
    return true;
  }

  async addModel(projectId: string, model: ModelRecord): Promise<void> {
    const project = this.requireProject(projectId);
    project.models.push(model);
    project.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async updateModel(projectId: string, modelId: string, updates: Partial<ModelRecord>): Promise<ModelRecord> {
    const project = this.requireProject(projectId);
    const model = project.models.find((item) => item.id === modelId);
    if (!model) throw new Error(`Model not found: ${modelId}`);
    Object.assign(model, updates, { updatedAt: new Date().toISOString() });
    project.updatedAt = model.updatedAt;
    await this.persist();
    return structuredClone(model);
  }

  async removeModel(projectId: string, modelId: string): Promise<boolean> {
    const project = this.requireProject(projectId);
    const originalLength = project.models.length;
    project.models = project.models.filter((item) => item.id !== modelId);
    if (project.models.length === originalLength) return false;
    project.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  listScenes(projectId: string): SceneSnapshot[] {
    return structuredClone(this.document.scenes
      .filter((scene) => scene.projectId === projectId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)));
  }

  getScene(projectId: string, sceneId: string): SceneSnapshot | undefined {
    const scene = this.document.scenes.find((item) => item.projectId === projectId && item.id === sceneId);
    return scene ? structuredClone(scene) : undefined;
  }

  getSceneById(sceneId: string): SceneSnapshot | undefined {
    const scene = this.document.scenes.find((item) => item.id === sceneId);
    return scene ? structuredClone(scene) : undefined;
  }

  async saveScene(scene: SceneSnapshot): Promise<SceneSnapshot> {
    const index = this.document.scenes.findIndex((item) => item.projectId === scene.projectId && item.id === scene.id);
    if (index >= 0) this.document.scenes[index] = structuredClone(scene);
    else this.document.scenes.push(structuredClone(scene));
    await this.persist();
    return structuredClone(scene);
  }

  async removeScene(projectId: string, sceneId: string): Promise<boolean> {
    const originalLength = this.document.scenes.length;
    this.document.scenes = this.document.scenes.filter(
      (item) => item.projectId !== projectId || item.id !== sceneId
    );
    if (this.document.scenes.length === originalLength) return false;
    this.document.publishedScenes = (this.document.publishedScenes ?? []).filter((item) => item.sceneId !== sceneId);
    await this.persist();
    return true;
  }

  getPublication(sceneId: string): PublishedSceneRecord | undefined {
    const publication = (this.document.publishedScenes ?? []).find((item) => item.sceneId === sceneId);
    return publication ? structuredClone(publication) : undefined;
  }

  async savePublication(publication: PublishedSceneRecord): Promise<PublishedSceneRecord> {
    this.document.publishedScenes ??= [];
    const index = this.document.publishedScenes.findIndex((item) => item.sceneId === publication.sceneId);
    if (index >= 0) this.document.publishedScenes[index] = structuredClone(publication);
    else this.document.publishedScenes.push(structuredClone(publication));
    await this.persist();
    return structuredClone(publication);
  }

  async removePublication(sceneId: string): Promise<boolean> {
    const publications = this.document.publishedScenes ?? [];
    const originalLength = publications.length;
    this.document.publishedScenes = publications.filter((item) => item.sceneId !== sceneId);
    if (this.document.publishedScenes.length === originalLength) return false;
    const scene = this.document.scenes.find((item) => item.id === sceneId);
    if (scene) delete scene.publishedAt;
    await this.persist();
    return true;
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.document.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  protected async persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const temporaryPath = `${this.databasePath}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(this.document, null, 2), "utf8");
      await rename(temporaryPath, this.databasePath);
    });
    await this.writeChain;
  }
}

export class PostgresStore extends JsonStore {
  private readonly postgres: AppConfig["metadata"]["postgres"];
  private postgresWriteChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, config: AppConfig["metadata"]["postgres"]) {
    super(dataDir);
    this.postgres = config;
  }

  override async init(): Promise<void> {
    await mkdir(path.dirname(this.databasePath), { recursive: true });
    await this.ensureDatabase();
    await this.sql(`CREATE TABLE IF NOT EXISTS bim_studio_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      document JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const encoded = (await this.sql("SELECT encode(convert_to(document::text, 'UTF8'), 'base64') FROM bim_studio_state WHERE id = 1", true)).trim();
    if (encoded) {
      this.document = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as DatabaseDocument;
      this.document.publishedScenes ??= [];
      return;
    }
    try {
      this.document = JSON.parse(await readFile(this.databasePath, "utf8")) as DatabaseDocument;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.document = defaultDocument();
    }
    await this.persist();
  }

  protected override async persist(): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(this.document), "utf8").toString("base64");
    this.postgresWriteChain = this.postgresWriteChain.then(async () => {
      await this.sql(`INSERT INTO bim_studio_state (id, document, updated_at)
        VALUES (1, convert_from(decode('${encoded}', 'base64'), 'UTF8')::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, updated_at = NOW()`);
    });
    await this.postgresWriteChain;
  }

  private async ensureDatabase(): Promise<void> {
    if (!/^[a-zA-Z0-9_]+$/.test(this.postgres.database)) throw new Error("PostgreSQL 数据库名称无效");
    const exists = (await this.sql(
      `SELECT 1 FROM pg_database WHERE datname = '${this.postgres.database}'`,
      true,
      "postgres"
    )).trim();
    if (exists !== "1") await this.sql(`CREATE DATABASE ${this.postgres.database} ENCODING 'UTF8'`, false, "postgres");
  }

  private sql(statement: string, tuplesOnly = false, database = this.postgres.database): Promise<string> {
    const args = [
      "-X", "-v", "ON_ERROR_STOP=1",
      "-h", this.postgres.host,
      "-p", String(this.postgres.port),
      "-U", this.postgres.user,
      "-d", database,
      ...(tuplesOnly ? ["-t", "-A"] : []),
      "-c", statement
    ];
    return runProcess(this.postgres.psqlPath, args, { PGPASSWORD: this.postgres.password });
  }
}

export function createMetadataStore(config: AppConfig): MetadataStore {
  return config.metadata.provider === "postgres"
    ? new PostgresStore(config.dataDir, config.metadata.postgres)
    : new JsonStore(config.dataDir);
}

function defaultDocument(): DatabaseDocument {
  const now = new Date().toISOString();
  return {
    projects: [{
      id: "default",
      name: "示例项目",
      description: "上传 IFC、GLTF、GLB、FBX、DXF，或配置 RVT 转换器",
      models: [],
      createdAt: now,
      updatedAt: now
    }],
    scenes: [],
    publishedScenes: []
  };
}

function runProcess(command: string, args: string[], extraEnvironment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      shell: false,
      env: { ...process.env, ...extraEnvironment }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString());
    child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString());
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `进程退出码 ${String(code)}`)));
  });
}
