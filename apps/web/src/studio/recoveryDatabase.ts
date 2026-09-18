const DATABASE_NAME = "bim-studio-recovery";
const STORE_NAME = "workspace-drafts";

/** 三维与应用恢复共用本地事务存储；成功仅在事务提交后返回。 */
export async function readRecoveryRecord(key: string): Promise<unknown> {
  return run("readonly", store => store.get(key));
}
/** 按命名空间读取记录，避免任务恢复读取不相关的场景草稿。 */
export async function readRecoveryRecords(prefix: string): Promise<unknown[]> {
  return run("readonly", store => store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`)));
}
export async function writeRecoveryRecord(value: { key: string }): Promise<void> {
  await run("readwrite", store => store.put(value));
}
export async function removeRecoveryRecord(key: string): Promise<void> {
  await run("readwrite", store => store.delete(key));
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error("本地恢复存储读取失败"));
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("本地恢复存储事务中止")); };
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) return Promise.reject(new Error("IndexedDB unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地恢复存储"));
  });
}
