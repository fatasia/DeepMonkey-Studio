import { randomUUID } from "node:crypto";
import type { MetadataStore } from "./metadataStore.js";
import { CONVERSION_LEASE_TTL_MS, type ConversionTaskLease } from "./conversionTaskLease.js";

export type ConversionPersistence = Pick<MetadataStore, "listConversionTasks" | "saveConversionTask"
  | "refreshConversionTasks" | "acquireConversionTaskLease" | "renewConversionTaskLease"
  | "releaseConversionTaskLease" | "activeConversionTaskLease" | "requestConversionCancellation">;
interface Session { lease: ConversionTaskLease; timer?: ReturnType<typeof setTimeout>; lost?: Error; closed: boolean; }

/** 排队期也续租；失去所有权后只中止本地执行，最终写入仍由数据库 fencing 判定。 */
export class ConversionLeaseSessions {
  private readonly ownerId = randomUUID();
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly store: ConversionPersistence | undefined, private readonly onLost: (taskId: string, error: Error) => void,
    private readonly onCancel: (taskId: string) => Promise<void>) {}

  async claim(taskId: string): Promise<void> {
    if (!this.store?.acquireConversionTaskLease) return;
    if (!this.store.renewConversionTaskLease || !this.store.releaseConversionTaskLease || !this.store.activeConversionTaskLease) {
      throw new Error("转换任务租约接口不完整");
    }
    const lease = await this.store.acquireConversionTaskLease(taskId, this.ownerId);
    if (!lease) throw new Error("转换任务已由其他执行器持有");
    const session: Session = { lease, closed: false };
    this.sessions.set(taskId, session);
    this.schedule(session);
  }

  token(taskId: string): ConversionTaskLease | undefined {
    const session = this.sessions.get(taskId);
    if (session?.lost) throw session.lost;
    return session?.lease;
  }

  owns(taskId: string): boolean { return !this.store?.acquireConversionTaskLease || this.sessions.has(taskId); }

  async checkCancellation(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session || session.closed || session.lost) return;
    const next = await this.store!.renewConversionTaskLease!(session.lease);
    if (!next) throw new Error("转换任务租约已失效，执行已停止");
    session.lease = next;
    if (next.cancelRequested) await this.onCancel(taskId);
  }

  async close(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (!session) return;
    session.closed = true;
    clearTimeout(session.timer);
    this.sessions.delete(taskId);
    // 释放失败只延迟数据库到期，不能把已经提交的终态改为失败。
    try { await this.store!.releaseConversionTaskLease!(session.lease); } catch { /* 数据库 TTL 负责回收。 */ }
  }

  private schedule(session: Session): void {
    session.timer = setTimeout(() => void this.renew(session), CONVERSION_LEASE_TTL_MS / 3);
    session.timer.unref?.();
  }

  private async renew(session: Session): Promise<void> {
    if (session.closed) return;
    try {
      const next = await this.store!.renewConversionTaskLease!(session.lease);
      if (!next) throw new Error("转换任务租约已失效，执行已停止");
      if (session.closed) return;
      session.lease = next;
      if (next.cancelRequested) await this.onCancel(next.taskId);
      if (session.closed) return;
      this.schedule(session);
    } catch (error) {
      if (session.closed) return;
      session.lost = error instanceof Error ? error : new Error(String(error));
      this.onLost(session.lease.taskId, session.lost);
    }
  }
}
