import type { Page } from "playwright-core";
import type { InputEvent } from "./chromiumInputBridge.js";

type QueueEvent = InputEvent | { type: "reset" };
type MouseButton = "left" | "middle" | "right";
const MAX_PENDING_INPUTS = 128;

/** CDP 输入必须串行；连续移动只保留最新位置，按下/释放是不可合并的顺序边界。 */
export function createInputQueue(page: Pick<Page, "mouse" | "keyboard">, width: number, height: number, onError: (error: unknown) => void) {
  const pending: QueueEvent[] = [];
  const buttons = new Set<MouseButton>();
  const keys = new Set<string>();
  let draining: Promise<void> | undefined;
  let closed = false;
  const stats = { received: 0, applied: 0, coalesced: 0, overflows: 0, maxPending: 0 };

  async function releaseAll() {
    for (const button of buttons) { try { await page.mouse.up({ button }); } catch { /* 页面关闭时仍继续释放其他已按键。 */ } }
    for (const key of keys) { try { await page.keyboard.up(key); } catch { /* 页面关闭时无需再次排队。 */ } }
    buttons.clear(); keys.clear();
  }
  async function apply(input: QueueEvent) {
    if (input.type === "reset") return releaseAll();
    if (input.type === "pointer") {
      await page.mouse.move(input.x * width, input.y * height);
      if (input.action === "down") { buttons.add(input.button); await page.mouse.down({ button: input.button }); }
      if (input.action === "up") { await page.mouse.up({ button: input.button }); buttons.delete(input.button); }
    } else if (input.type === "wheel") await page.mouse.wheel(input.deltaX, input.deltaY);
    else if (input.action === "down") { keys.add(input.key); await page.keyboard.down(input.key); }
    else { await page.keyboard.up(input.key); keys.delete(input.key); }
  }
  async function drain() {
    while (!closed && pending.length) {
      const input = pending.shift()!;
      try { await apply(input); stats.applied++; }
      catch (error) { if (!closed) { onError(error); await releaseAll(); } }
    }
  }
  function startDrain() {
    draining ??= Promise.resolve().then(drain).finally(() => {
      draining = undefined;
      if (!closed && pending.length) startDrain();
    });
  }
  return {
    enqueue(input: InputEvent) {
      if (closed) return;
      stats.received++;
      const last = pending.at(-1);
      if (input.type === "pointer" && input.action === "move" && last?.type === "pointer" && last.action === "move") {
        pending[pending.length - 1] = input; stats.coalesced++;
      } else {
        // 超载时释放实际按下状态，丢弃过时操作；不能静默遗失 mouseup/keyup 留下粘键。
        if (pending.length >= MAX_PENDING_INPUTS) { pending.length = 0; pending.push({ type: "reset" }); stats.overflows++; }
        pending.push(input);
      }
      stats.maxPending = Math.max(stats.maxPending, pending.length);
      startDrain();
    },
    idle: async () => { while (draining) await draining; },
    close: () => { closed = true; pending.length = 0; },
    stats: () => ({ ...stats, pending: pending.length }),
  };
}
