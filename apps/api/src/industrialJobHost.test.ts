import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runIndustrialJob } from "./industrialJobExecutor.js";
import type { ConverterPluginManifest } from "@bim-studio/contracts";

const host = fileURLToPath(new URL("../dist/industrial-worker/industrial-worker-host.exe", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/industrialJobProbe.mjs", import.meta.url));
const children: ChildProcess[] = [], directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const dead = (pid: number) => { expect(() => process.kill(pid, 0)).toThrow(); };
async function directory() { const value = await mkdtemp(path.join(tmpdir(), "bim-job-test-")); directories.push(value); return value; }
async function pids(file: string) {
  let value: { workerPid: number; descendantPid?: number } | undefined;
  await vi.waitFor(async () => { value = JSON.parse(await readFile(file, "utf8")); }, { timeout: 5000 });
  return value!;
}
async function run(mode: string, limits = { maxMemoryMb: 512, timeoutMs: 10000, maxCpuPercent: 100 }) {
  const pidFile = path.join(await directory(), "pids.json");
  const child = spawn(host, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  child.stdin.on("error", () => {});
  const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  child.stdin.write(JSON.stringify({ parentPid: process.pid, executable: process.execPath, arguments: [probe], payload: { mode, pidFile }, ...limits }) + "\n");
  return { child, closed, pidFile, output: () => ({ stdout, stderr }) };
}

describe.skipIf(process.platform !== "win32")("industrial Windows Job OS limits", () => {
  it("projects complete conversion limits onto the strict host protocol", async () => {
    const limits: ConverterPluginManifest["limits"] = {
      timeoutMs: 10000, maxInputBytes: 2 * 1024 ** 3, maxOutputBytes: 4 * 1024 ** 3,
      maxMemoryMb: 512, maxCpuPercent: 100,
    };
    const pidFile = path.join(await directory(), "complete-limits.json");
    let exited: Promise<void> | undefined;
    await expect(runIndustrialJob({ executable: process.execPath, arguments: [probe], payload: { mode: "result", pidFile },
      limits, registerResourceExit: value => { exited = value; } })).resolves.toEqual({ ok: true });
    expect(exited).toBeDefined(); await exited;
    dead((await pids(pidFile)).workerPid);
    // The adapter must project fields; weakening the native schema is not a fix.
    const raw = await run("result", limits);
    expect(await raw.closed).toBe(2);
    expect(raw.output().stderr).toContain("unknown field `maxInputBytes`");
  });
  it("uses the shared adapter without releasing resources before the worker exits", async () => {
    const pidFile=path.join(await directory(),"adapter-pids.json");let exit:Promise<void>|undefined;
    const result=await runIndustrialJob({executable:process.execPath,arguments:[probe],payload:{mode:"result",pidFile},
      limits:{maxMemoryMb:512,timeoutMs:10000,maxCpuPercent:100},registerResourceExit:value=>{exit=value;}});
    expect(result).toEqual({ok:true});expect(exit).toBeDefined();await exit;
    dead((await pids(pidFile)).workerPid);
  });
  it("cancels the shared adapter and enforces a byte receipt budget", async () => {
    const pidFile=path.join(await directory(),"adapter-tree.json"),controller=new AbortController();let exit:Promise<void>|undefined;
    const pending=runIndustrialJob({executable:process.execPath,arguments:[probe],payload:{mode:"tree",pidFile},signal:controller.signal,
      limits:{maxMemoryMb:512,timeoutMs:10000,maxCpuPercent:100},registerResourceExit:value=>{exit=value;}});
    const rejection = pending.then(() => undefined, error => error as Error);
    const identity=await pids(pidFile);controller.abort();
    const error = await rejection;
    expect(error).toBeInstanceOf(Error); expect(error?.message).toContain("取消");
    await exit;
    dead(identity.workerPid);dead(identity.descendantPid!);
    await expect(runIndustrialJob({executable:process.execPath,arguments:[probe],payload:{mode:"result",pidFile},maxOutputBytes:1,
      limits:{maxMemoryMb:512,timeoutMs:10000,maxCpuPercent:100}})).rejects.toThrow("回执超限");
  });
  it("returns only after successful reader exit", async () => {
    const task = await run("result"); expect(await task.closed).toBe(0);
    const identity = await pids(task.pidFile); dead(identity.workerPid);
    expect(JSON.parse(task.output().stdout)).toEqual({ ok: true });
  });
  it("cancellation confirms worker and live descendant are gone before host closes", async () => {
    const task = await run("tree"); const identity = await pids(task.pidFile);
    task.child.stdin.end("cancel\n"); expect(await task.closed).toBe(2);
    dead(identity.workerPid); dead(identity.descendantPid!);
    expect(task.output().stderr).toContain("cancelled");
  });
  it("kill-on-close reaps descendants when the host itself is forcibly killed", async () => {
    const task = await run("tree"); const identity = await pids(task.pidFile);
    task.child.kill("SIGKILL"); await task.closed;
    await vi.waitFor(() => { dead(identity.workerPid); dead(identity.descendantPid!); });
  });
  it("parent API death reaps host, reader and grandchild without PID polling in the host", async () => {
    const pidFile = path.join(await directory(), "pids.json");
    const parent = spawn(process.execPath, [probe, "parent", host, pidFile], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); children.push(parent);
    const hostPid = await new Promise<number>(resolve => { parent.stdout.once("data", bytes => resolve(JSON.parse(String(bytes)).hostPid)); });
    const identity = await pids(pidFile); parent.kill("SIGKILL");
    await vi.waitFor(() => { dead(hostPid); dead(identity.workerPid); dead(identity.descendantPid!); }, { timeout: 5000 });
  });
  it.each(["cpu", "memory", "crash"])("fails closed for real %s exhaustion/fault", async mode => {
    const task = await run(mode, { maxMemoryMb: mode === "memory" ? 128 : 512, timeoutMs: 10000, maxCpuPercent: mode === "cpu" ? 1 : 100 });
    expect(await task.closed).toBe(2); const identity = await pids(task.pidFile); dead(identity.workerPid);
    expect(task.output().stdout).toBe("");
    expect(task.output().stderr).toMatch(/budget exceeded|worker exited/);
  }, 15000);
  it("wall-clock deadline reaps a live descendant tree", async () => {
    const task = await run("tree", { maxMemoryMb: 512, timeoutMs: 1000, maxCpuPercent: 100 });
    expect(await task.closed).toBe(2); const identity = await pids(task.pidFile);
    dead(identity.workerPid); dead(identity.descendantPid!);
    expect(task.output().stderr).toContain("wall-clock budget");
  });
});
