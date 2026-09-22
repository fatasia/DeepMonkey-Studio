import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBuiltinJtWorker } from "./builtinJtWorkerExecutor.js";
import { withConversionDeadline } from "./conversionExecutionDeadline.js";

const fixture = fileURLToPath(new URL("./fixtures/builtinJtWorkerFailure.mjs", import.meta.url));
const request = { sourcePath: "unused", outputDir: "unused", sourceName: "busy" };
function childFactory(onStarted?: () => void) {
  let child: ChildProcess;
  return {
    createChild: () => {
      child = fork(fixture, [], { execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      // 故障夹具的 ready 消息仅供测试同步，不进入生产协议。
      const emit = child.emit.bind(child);
      child.emit = ((event: string, ...args: unknown[]) => {
        if (event === "message" && (args[0] as { type?: string })?.type === "started") { onStarted?.(); return true; }
        return emit(event, ...args);
      }) as typeof child.emit;
      return child;
    },
    assertDead: () => expect(() => process.kill(child.pid!, 0)).toThrow(),
  };
}

describe("builtin JT OS worker lifetime", () => {
  it("kills a real CPU-bound process on cancellation and waits for close", async () => {
    const controller = new AbortController();
    const child = childFactory(() => controller.abort());
    let exit!: Promise<void>;
    await expect(runBuiltinJtWorker(request, { ...child, signal: controller.signal, registerResourceExit: value => { exit = value; } })).rejects.toThrow("取消");
    await exit;
    child.assertDead();
  });
  it("deadline cannot finish before the registered OS resource closes", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const child = childFactory(started);
    let exit!: Promise<void>;
    const running = runBuiltinJtWorker(request, { ...child, signal: controller.signal, registerResourceExit: value => { exit = value; } });
    void running.catch(() => {});
    await ready;
    await expect(withConversionDeadline(async () => { await running; }, controller, 20, () => exit)).rejects.toThrow("超时");
    child.assertDead();
  });
  it.each(["crash", "protocol"])("fails closed on %s and has no surviving PID", async sourceName => {
    const child = childFactory();
    await expect(runBuiltinJtWorker({ ...request, sourceName }, child)).rejects.toThrow();
    child.assertDead();
  });
  it("does not create a process after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    expect(() => runBuiltinJtWorker(request, { signal: controller.signal, createChild: () => { throw new Error("must not spawn"); } })).toThrow();
  });
});
