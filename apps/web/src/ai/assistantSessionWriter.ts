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

  constructor(private readonly save: (message: AiSessionMessageInput) => Promise<unknown>, private readonly onError: (error: unknown) => void) {}

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
    })().finally(() => { this.active = undefined; });
    return this.active;
  }
}
