import type {
  ApplicationDocument,
  ProjectRecord,
  PublishedApplicationRecord,
  PublishedSceneRecord,
  SceneSnapshot,
} from "@bim-studio/contracts";

const DATABASE_NAME = "bim-studio-local-workspace";
const DATABASE_VERSION = 3;
const STORE_NAME = "workspace";
const ASSET_STORE_NAME = "model-assets";
const SCRIPT_DEPENDENCY_STORE_NAME = "script-dependencies";
const STATE_KEY = "primary";

export interface DesktopLocalWorkspaceState {
  schemaVersion: 1;
  projects: ProjectRecord[];
  scenes: SceneSnapshot[];
  applications: ApplicationDocument[];
  scenePublications: PublishedSceneRecord[];
  applicationPublications: PublishedApplicationRecord[];
}

export interface DesktopLocalWorkspaceStore {
  read(): Promise<DesktopLocalWorkspaceState>;
  write(state: DesktopLocalWorkspaceState): Promise<void>;
  readModelAsset(modelId: string): Promise<Blob | undefined>;
  writeModelAsset(modelId: string, asset: Blob): Promise<void>;
  deleteModelAsset(modelId: string): Promise<void>;
  readScriptDependency(dependencyId: string): Promise<Blob | undefined>;
  writeScriptDependency(dependencyId: string, asset: Blob): Promise<void>;
  deleteScriptDependency(dependencyId: string): Promise<void>;
}

/** IndexedDB 让本地草稿独立于服务器，并保留比 localStorage 更合理的容量与事务语义。 */
export class IndexedDbDesktopLocalWorkspaceStore implements DesktopLocalWorkspaceStore {
  async read(): Promise<DesktopLocalWorkspaceState> {
    const database = await openDatabase();
    const stored = await transact(database, "readonly", (store) => store.get(STATE_KEY));
    return isWorkspaceState(stored) ? structuredClone(stored) : createInitialWorkspaceState();
  }

  async write(state: DesktopLocalWorkspaceState): Promise<void> {
    const database = await openDatabase();
    await transact(database, "readwrite", (store) => store.put(structuredClone(state), STATE_KEY));
  }

  async readModelAsset(modelId: string): Promise<Blob | undefined> {
    const database = await openDatabase();
    const stored = await transactStore(database, ASSET_STORE_NAME, "readonly", (store) => store.get(modelId));
    return stored instanceof Blob ? stored : undefined;
  }

  async writeModelAsset(modelId: string, asset: Blob): Promise<void> {
    const database = await openDatabase();
    await transactStore(database, ASSET_STORE_NAME, "readwrite", (store) => store.put(asset, modelId));
  }

  async deleteModelAsset(modelId: string): Promise<void> {
    const database = await openDatabase();
    await transactStore(database, ASSET_STORE_NAME, "readwrite", (store) => store.delete(modelId));
  }

  async readScriptDependency(dependencyId: string): Promise<Blob | undefined> {
    const database = await openDatabase();
    const stored = await transactStore(database, SCRIPT_DEPENDENCY_STORE_NAME, "readonly", (store) => store.get(dependencyId));
    return stored instanceof Blob ? stored : undefined;
  }

  async writeScriptDependency(dependencyId: string, asset: Blob): Promise<void> {
    const database = await openDatabase();
    await transactStore(database, SCRIPT_DEPENDENCY_STORE_NAME, "readwrite", (store) => store.put(asset, dependencyId));
  }

  async deleteScriptDependency(dependencyId: string): Promise<void> {
    const database = await openDatabase();
    await transactStore(database, SCRIPT_DEPENDENCY_STORE_NAME, "readwrite", (store) => store.delete(dependencyId));
  }
}

export function createInitialWorkspaceState(now = new Date().toISOString()): DesktopLocalWorkspaceState {
  return {
    schemaVersion: 1,
    projects: [{
      id: "local-project",
      name: "本地项目",
      description: "无需服务器即可编辑；完成后可打包并上传到在线项目。",
      models: [],
      createdAt: now,
      updatedAt: now,
    }],
    scenes: [],
    applications: [],
    scenePublications: [],
    applicationPublications: [],
  };
}

function isWorkspaceState(value: unknown): value is DesktopLocalWorkspaceState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<DesktopLocalWorkspaceState>;
  return state.schemaVersion === 1
    && Array.isArray(state.projects)
    && Array.isArray(state.scenes)
    && Array.isArray(state.applications)
    && Array.isArray(state.scenePublications)
    && Array.isArray(state.applicationPublications);
}

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) return Promise.reject(new Error("当前 WebView 不支持 IndexedDB，无法使用本地工作台"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      if (!request.result.objectStoreNames.contains(ASSET_STORE_NAME)) request.result.createObjectStore(ASSET_STORE_NAME);
      if (!request.result.objectStoreNames.contains(SCRIPT_DEPENDENCY_STORE_NAME)) request.result.createObjectStore(SCRIPT_DEPENDENCY_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地工作台数据库"));
  });
}

function transact<T>(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = run(transaction.objectStore(STORE_NAME));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error("本地工作台数据库请求失败"));
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("本地工作台事务未提交")); };
  });
}

function transactStore<T>(
  database: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = run(transaction.objectStore(storeName));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error("本地模型资源请求失败"));
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("本地模型资源事务未提交")); };
  });
}
