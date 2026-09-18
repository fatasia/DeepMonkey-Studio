import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { MinioObjectStore } from "./objects.js";

const fixture = vi.hoisted(() => ({ script: "", children: [] as ChildProcessWithoutNullStreams[], calls: [] as unknown[][] }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    fixture.calls.push(args);
    // 仅替换 mc 的可执行入口；stdio、事件、退出与 kill 全部由真实 Node 子进程提供。
    const child = actual.spawn(process.execPath, ["-e", fixture.script], { windowsHide: true, shell: false });
    fixture.children.push(child); return child;
  } };
});
afterEach(async () => {
  await Promise.all(fixture.children.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once("close", () => resolve()); child.kill();
  })));
  fixture.calls = [];
});
const store = () => new MinioObjectStore({ mcPath: "fixture-mc", endpoint: "http://localhost:9000", accessKey: "test", secretKey: "test", bucket: "bucket", alias: "local" });

describe("MinioObjectStore real read process lifecycle", () => {
  it("reads all bytes and waits for a successful process close without killing normal EOF", async () => {
    fixture.script = "process.stdout.write('first'); setTimeout(()=>{process.stdout.end('last');},20);";
    const result = await store().read("projects/project/file"); const child = fixture.children[0]!;
    const kill = vi.spyOn(child, "kill"); const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(chunk);
    await result.completed;
    expect(Buffer.concat(chunks).toString()).toBe("firstlast"); expect(kill).not.toHaveBeenCalled(); expect(child.exitCode).toBe(0);
    expect(fixture.calls[0]).toMatchObject(["fixture-mc", ["cat", "local/bucket/projects/project/file"], { windowsHide: true, shell: false }]);
  });

  it("kills a continuously producing child when its returned stream is destroyed", async () => {
    fixture.script = "setInterval(()=>process.stdout.write('chunk'),5);";
    const result = await store().read("projects/project/file"), child = fixture.children[0]!;
    const kill = vi.spyOn(child, "kill"); const rejected = expect(result.completed).rejects.toMatchObject({ name: "AbortError" });
    await new Promise<void>(resolve => result.stream.once("data", () => { result.stream.destroy(); resolve(); }));
    await rejected; expect(kill).toHaveBeenCalledOnce(); expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("kills a silent child cancelled before its first byte and allows delayed completed observation", async () => {
    fixture.script = "setInterval(()=>{},1000);";
    const result = await store().read("projects/project/file"), child = fixture.children[0]!;
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    result.stream.destroy(); await closed;
    await expect(result.completed).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not mistake normal EOF followed by delayed process exit for cancellation", async () => {
    fixture.script = "process.stdout.end('complete');setTimeout(()=>{},50);";
    const result = await store().read("projects/project/file"), child = fixture.children[0]!;
    const kill = vi.spyOn(child, "kill");
    for await (const _chunk of result.stream) { /* 消费正常输出。 */ }
    await result.completed; expect(kill).not.toHaveBeenCalled(); expect(child.exitCode).toBe(0);
  });

  it("retains process failure after output EOF and bounds error diagnostics", async () => {
    fixture.script = "process.stdout.write('partial');process.stderr.write('x'.repeat(65536)+' failure',()=>process.exit(7));";
    const result = await store().read("projects/project/file");
    for await (const _chunk of result.stream) { /* 输出不等于进程成功。 */ }
    const reason = await result.completed.then(() => undefined, (error: Error) => error);
    expect(reason).toBeInstanceOf(Error); expect(reason!.message).toContain("failure"); expect(reason!.message.length).toBeLessThanOrEqual(16_384);
  });
});
