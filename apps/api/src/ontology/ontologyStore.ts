import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  canTransitionOntologyStatus,
  ontologyPackageFingerprint,
  validateOntologyPackageShape,
  validateOntologyPublishGate,
  type OntologyHistoryEntry,
  type OntologyPackage,
  type OntologyPackageSnapshot,
  type OntologyPublishContext,
  type OntologyStatus,
} from "@bim-studio/contracts";

/**
 * H-C4-P0 本体包存储（数据中心"语义与本体"工作区的持久层）。
 *
 * 存储纪律（与 agentMemory 同一套）：
 * - dataDir/ontology/<projectId>/packages.json 每项目一份；
 * - 原子写（tmp + rename），写失败清临时文件；
 * - 串行化提交：读档 → clone → mutate → persist 全程在写链内（防并发整文件覆盖丢条目）；
 * - 内存缓存 + 加载时 fail-closed 形状过滤（坏条目丢弃不抛错，保住其余数据）；
 * - persist 成功才切换缓存，读侧永不暴露未落盘状态。
 *
 * 版本纪律：
 * - 草稿保存走 savePackageDraft（revision 服务端 +1，published/retired 拒绝直接改）；
 * - 发布走 publishPackage：九条门禁 fail-closed，通过后 version+1 并落快照；
 * - 快照上限 MAX_SNAPSHOTS，FIFO 淘汰最旧；回滚恢复快照内容并记 history。
 */

export const MAX_ONTOLOGY_SNAPSHOTS = 20;

export class OntologyPackageError extends Error {
  readonly code: "not-found" | "invalid" | "conflict" | "gate-failed";
  constructor(code: OntologyPackageError["code"], message: string) {
    super(message);
    this.name = "OntologyPackageError";
    this.code = code;
  }
}

export interface OntologyPackageRecord {
  current: OntologyPackage;
  snapshots: OntologyPackageSnapshot[];
  history: OntologyHistoryEntry[];
}

interface OntologyDocument {
  schemaVersion: 1;
  records: OntologyPackageRecord[];
}

/** fail-closed 形状过滤：磁盘上的坏条目直接丢弃（保文档其余部分可用）。 */
function isOntologyPackage(value: unknown): value is OntologyPackage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OntologyPackage>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.id === "string" && candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    Array.isArray(candidate.objects) &&
    Array.isArray(candidate.relations) &&
    Array.isArray(candidate.actions) &&
    Array.isArray(candidate.events) &&
    Array.isArray(candidate.metrics) &&
    Array.isArray(candidate.identityMappings) &&
    Array.isArray(candidate.goldenQuestions) &&
    Array.isArray(candidate.policies) &&
    Array.isArray(candidate.evidence) &&
    typeof candidate.status === "string"
  );
}

function sanitizeRecord(value: unknown): OntologyPackageRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<OntologyPackageRecord>;
  if (!isOntologyPackage(candidate.current)) return undefined;
  const snapshots = Array.isArray(candidate.snapshots)
    ? candidate.snapshots.filter((item): item is OntologyPackageSnapshot =>
        Boolean(item) && typeof item === "object" && isOntologyPackage((item as OntologyPackageSnapshot).package))
    : [];
  const history = Array.isArray(candidate.history) ? (candidate.history as OntologyHistoryEntry[]) : [];
  return { current: candidate.current, snapshots, history: history.filter((item) => item && typeof item.action === "string") };
}

export class OntologyPackageStore {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #maxSnapshots: number;
  #documents = new Map<string, OntologyDocument>();
  #writes: Promise<void> = Promise.resolve();

  constructor(dataDir: string, options: { now?: () => Date; maxSnapshots?: number } = {}) {
    this.#root = path.join(dataDir, "ontology");
    this.#now = options.now ?? (() => new Date());
    this.#maxSnapshots = options.maxSnapshots ?? MAX_ONTOLOGY_SNAPSHOTS;
  }

  async init(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
  }

  async listPackages(projectId: string): Promise<OntologyPackage[]> {
    const document = await this.#loadDocument(projectId);
    return structuredClone(document.records.map((record) => record.current));
  }

  async getPackage(projectId: string, packageId: string): Promise<OntologyPackage> {
    const document = await this.#loadDocument(projectId);
    const record = document.records.find((item) => item.current.id === packageId);
    if (!record) throw new OntologyPackageError("not-found", `本体包不存在：${packageId}`);
    return structuredClone(record.current);
  }

  async getSnapshots(projectId: string, packageId: string): Promise<OntologyPackageSnapshot[]> {
    const document = await this.#loadDocument(projectId);
    const record = this.#requireRecord(document, projectId, packageId);
    return structuredClone(record.snapshots);
  }

  async getHistory(projectId: string, packageId: string): Promise<OntologyHistoryEntry[]> {
    const document = await this.#loadDocument(projectId);
    const record = this.#requireRecord(document, projectId, packageId);
    return structuredClone(record.history);
  }

  /** 创建草稿：id/名称冲突拒绝；初始形状必须合法（空包 + 名称/域/Owner 即可通过）。 */
  async createPackage(projectId: string, input: OntologyPackage, actor: string): Promise<OntologyPackage> {
    const now = this.#now().toISOString();
    const pkg: OntologyPackage = {
      ...structuredClone(input),
      schemaVersion: 1,
      version: 0,
      revision: 1,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    const shapeErrors = validateOntologyPackageShape(pkg);
    if (shapeErrors.length) throw new OntologyPackageError("invalid", shapeErrors.join("；"));
    await this.#commit(projectId, (draft) => {
      if (draft.records.some((item) => item.current.id === pkg.id)) {
        throw new OntologyPackageError("conflict", `本体包 id 已存在：${pkg.id}`);
      }
      if (draft.records.some((item) => item.current.name.trim() === pkg.name.trim())) {
        throw new OntologyPackageError("conflict", `本体包名称“${pkg.name}”已被使用`);
      }
      draft.records.push({ current: pkg, snapshots: [], history: [{ at: now, by: actor, action: "create", detail: "创建草稿" }] });
      return structuredClone(pkg);
    });
    return pkg;
  }

  /**
   * 保存草稿：仅 draft/review 可保存；published/retired 必须先开新草稿版本。
   * revision 由服务端 +1（对齐 SemanticModelRecord 纪律），状态与 version 不可被客户端改写。
   */
  async savePackageDraft(projectId: string, input: OntologyPackage): Promise<OntologyPackage> {
    const shapeErrors = validateOntologyPackageShape({ ...input, status: "draft" });
    if (shapeErrors.length) throw new OntologyPackageError("invalid", shapeErrors.join("；"));
    const now = this.#now().toISOString();
    return this.#commit(projectId, (draft) => {
      const record = draft.records.find((item) => item.current.id === input.id);
      if (!record) throw new OntologyPackageError("not-found", `本体包不存在：${input.id}`);
      if (record.current.status !== "draft" && record.current.status !== "review") {
        throw new OntologyPackageError("conflict", `本体包处于“${record.current.status}”状态，不能直接修改；请基于已发布版本开新草稿`);
      }
      if (input.revision !== record.current.revision) {
        throw new OntologyPackageError("conflict", "本体包已被修改，请读取最新版本后再保存");
      }
      if (draft.records.some((item) => item.current.id !== input.id && item.current.name.trim() === input.name.trim())) {
        throw new OntologyPackageError("conflict", `本体包名称“${input.name}”已被使用`);
      }
      const next: OntologyPackage = {
        ...structuredClone(input),
        schemaVersion: 1,
        status: record.current.status,
        version: record.current.version,
        revision: record.current.revision + 1,
        createdAt: record.current.createdAt,
        updatedAt: now,
      };
      record.current = next;
      return structuredClone(next);
    });
  }

  /** 状态流转（提交评审/驳回/退役），published 转换走 publish/rollback 专用入口。 */
  async transitionStatus(projectId: string, packageId: string, to: OntologyStatus, actor: string, detail?: string): Promise<OntologyPackage> {
    const now = this.#now().toISOString();
    return this.#commit(projectId, (draft) => {
      const record = this.#requireRecord(draft, projectId, packageId);
      const from = record.current.status;
      if (to === "published") throw new OntologyPackageError("invalid", "发布必须走 publish 入口（九条门禁）");
      if (!canTransitionOntologyStatus(from, to)) {
        throw new OntologyPackageError("invalid", `不允许从“${from}”转换到“${to}”`);
      }
      record.current.status = to;
      record.current.updatedAt = now;
      record.history.push({ at: now, by: actor, action: to === "retired" ? "retire" : to === "review" ? "review-submit" : "review-reject", ...(detail ? { detail } : {}) });
      return structuredClone(record.current);
    });
  }

  /**
   * 发布：形状校验 → 九条门禁（fail-closed）→ version+1 + 快照 + history。
   * 只有 review 状态可发布（draft 必须先提交评审）。
   */
  async publishPackage(projectId: string, packageId: string, actor: string, ctx: OntologyPublishContext): Promise<OntologyPackage> {
    const now = this.#now().toISOString();
    return this.#commit(projectId, (draft) => {
      const record = this.#requireRecord(draft, projectId, packageId);
      if (record.current.status !== "review") {
        throw new OntologyPackageError("invalid", `只有“待评审”状态可以发布，当前为“${record.current.status}”`);
      }
      const shapeErrors = validateOntologyPackageShape(record.current);
      if (shapeErrors.length) throw new OntologyPackageError("invalid", shapeErrors.join("；"));
      const report = validateOntologyPublishGate(record.current, ctx);
      if (!report.ok) throw new OntologyPackageError("gate-failed", report.errors.join("；"));

      const published: OntologyPackage = {
        ...structuredClone(record.current),
        version: record.current.version + 1,
        status: "published",
        updatedAt: now,
      };
      for (const child of [...published.objects, ...published.relations, ...published.actions, ...published.events]) {
        child.status = "published";
        child.version = published.version;
      }
      const snapshot: OntologyPackageSnapshot = {
        snapshotId: `snap-${randomUUID()}`,
        packageId,
        version: published.version,
        fingerprint: ontologyPackageFingerprint(published),
        publishedAt: now,
        publishedBy: actor,
        package: published,
      };
      record.snapshots = [snapshot, ...record.snapshots].slice(0, this.#maxSnapshots);
      record.history.push({ at: now, by: actor, action: "publish", toVersion: published.version, fromVersion: record.current.version });
      record.current = published;
      return structuredClone(published);
    });
  }

  /** 回滚：把指定快照恢复为当前发布版本；被回滚的版本仍在快照列表中（可再滚回来）。 */
  async rollbackToSnapshot(projectId: string, packageId: string, snapshotId: string, actor: string): Promise<OntologyPackage> {
    const now = this.#now().toISOString();
    return this.#commit(projectId, (draft) => {
      const record = this.#requireRecord(draft, projectId, packageId);
      const snapshot = record.snapshots.find((item) => item.snapshotId === snapshotId);
      if (!snapshot) throw new OntologyPackageError("not-found", `发布快照不存在：${snapshotId}`);
      if (record.current.status !== "published") {
        throw new OntologyPackageError("invalid", `只有“已发布”状态可以回滚，当前为“${record.current.status}”`);
      }
      const restored: OntologyPackage = { ...structuredClone(snapshot.package), status: "published", updatedAt: now };
      const previousVersion = record.current.version;
      record.current = restored;
      record.history.push({ at: now, by: actor, action: "rollback", fromVersion: previousVersion, toVersion: snapshot.version, detail: `回滚到 v${snapshot.version}` });
      return structuredClone(restored);
    });
  }

  /** 基于已发布版本开新草稿（version 归零语义保持：草稿继承当前 version，发布时 +1）。 */
  async cloneAsDraft(projectId: string, packageId: string, actor: string): Promise<OntologyPackage> {
    const now = this.#now().toISOString();
    return this.#commit(projectId, (draft) => {
      const record = this.#requireRecord(draft, projectId, packageId);
      if (record.current.status !== "published" && record.current.status !== "retired") {
        throw new OntologyPackageError("invalid", "只有已发布/已退役版本可以派生新草稿");
      }
      const clone: OntologyPackage = {
        ...structuredClone(record.current),
        status: "draft",
        revision: record.current.revision + 1,
        updatedAt: now,
      };
      for (const child of [...clone.objects, ...clone.relations, ...clone.actions, ...clone.events]) child.status = "draft";
      record.current = clone;
      record.history.push({ at: now, by: actor, action: "new-draft-version", detail: "基于已发布版本开新草稿" });
      return structuredClone(clone);
    });
  }

  async deletePackage(projectId: string, packageId: string): Promise<boolean> {
    return this.#commit(projectId, (draft) => {
      const record = draft.records.find((item) => item.current.id === packageId);
      if (!record) return false;
      if (record.current.status === "published" || record.current.status === "retired") {
        throw new OntologyPackageError("conflict", "已发布/已退役的本体包不能删除，请先退役");
      }
      draft.records = draft.records.filter((item) => item.current.id !== packageId);
      return true;
    });
  }

  #requireRecord(document: OntologyDocument, projectId: string, packageId: string): OntologyPackageRecord {
    const record = document.records.find((item) => item.current.id === packageId);
    if (!record) throw new OntologyPackageError("not-found", `项目 ${projectId} 的本体包不存在：${packageId}`);
    return record;
  }

  /** 串行化提交（与 agentMemory.#commit 同一纪律，见其注释）。 */
  async #commit<T>(projectId: string, mutate: (draft: OntologyDocument) => T): Promise<T> {
    const operation = this.#writes.then(async () => {
      const document = await this.#loadDocument(projectId);
      const draft: OntologyDocument = structuredClone(document);
      const result = mutate(draft);
      await this.#persist(projectId, draft);
      this.#documents.set(projectId, draft);
      return result;
    });
    this.#writes = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #loadDocument(projectId: string): Promise<OntologyDocument> {
    const cached = this.#documents.get(projectId);
    if (cached) return cached;
    let document: OntologyDocument = { schemaVersion: 1, records: [] };
    try {
      const parsed = JSON.parse(await readFile(this.#documentPath(projectId), "utf8")) as Partial<OntologyDocument>;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.records)) {
        document = { schemaVersion: 1, records: parsed.records.map(sanitizeRecord).filter((item): item is OntologyPackageRecord => Boolean(item)) };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#documents.set(projectId, document);
    return document;
  }

  async #persist(projectId: string, document: OntologyDocument): Promise<void> {
    const filePath = this.#documentPath(projectId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  #documentPath(projectId: string): string {
    return path.join(this.#root, projectId, "packages.json");
  }
}
