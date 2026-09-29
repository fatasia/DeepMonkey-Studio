import type { AiSessionMessageInput } from "@bim-studio/contracts";

type Snapshot = Omit<AiSessionMessageInput, "sequence">;
/** 串行保存流式快照；合并未发送的中间片段，终态排在最后且不会被迟到 delta 覆盖。 */
export class AssistantSessionWriter {
  private sequence = 0;
  private pending: AiSessionMessageInput | undefined;
  private active: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private terminal = false;
  private failure: unknown;
  private draining = false;

  constructor(private readonly save: (message: AiSessionMessageInput) => Promise<unknown>, private readonly onError: (error: unknown) => void) {}

  /**
   * T13（审计 §二 T13：作用域切换 writers.clear() 让旧作用域未落盘片段失去重试入口）：
   * 仍有未确认落盘内容（待发片段/失败重试/保存进行中）时为 true——跨作用域清理据此保留。
   */
  get unsaved(): boolean {
    return Boolean(this.pending || this.failure || this.draining);
  }

  update(snapshot: Snapshot) {
    if (this.terminal) return;
    this.pending = { ...snapshot, sequence: ++this.sequence };
    if (snapshot.status !== "streaming") {
      this.terminal = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      void this.drain();
    } else if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, 800);
    }
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.drain();
    if (this.failure) throw this.failure;
  }

  private drain(): Promise<void> {
    if (this.active) return this.active;
    // 同步置位：drain 在首个 await 前已取走 pending，作用域清理若恰好落在该窗口会把
    // 进行中的保存误判为"已落盘"而丢弃重试入口。
    this.draining = true;
    this.active = (async () => {
      while (this.pending) {
        const snapshot = this.pending; this.pending = undefined;
        try { await this.save(snapshot); this.failure = undefined; }
        catch (error) {
          this.failure = error;
          this.pending ??= snapshot;
          this.onError(error);
          break;
        }
      }
    })().finally(() => { this.active = undefined; this.draining = false; });
    return this.active;
  }
}
