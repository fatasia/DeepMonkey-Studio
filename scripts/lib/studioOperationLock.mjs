import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 串行化 start / stop / restart，避免两个终端同时改写同一运行状态。
 * 锁持有者异常退出后，可依据 PID 自动回收陈旧锁。
 */
export async function withStudioOperationLock(lockFile, operation) {
  const token = randomUUID();
  mkdirSync(dirname(lockFile), { recursive: true });
  acquire(lockFile, token);
  try {
    return await operation();
  } finally {
    release(lockFile, token);
  }
}

function acquire(lockFile, token) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(lockFile, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, "utf8");
      closeSync(descriptor);
      return;
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error?.code !== "EEXIST") throw error;
      const owner = readOwner(lockFile);
      if (owner?.pid && processIsAlive(owner.pid)) {
        throw new Error(`另一个运行管理操作正在执行（PID ${owner.pid}），请稍后重试`);
      }
      rmSync(lockFile, { force: true });
    }
  }
  throw new Error("无法取得运行管理锁，请检查 data/runtime 目录权限");
}

function release(lockFile, token) {
  const owner = readOwner(lockFile);
  if (owner?.token === token) rmSync(lockFile, { force: true });
}

function readOwner(lockFile) {
  try { return JSON.parse(readFileSync(lockFile, "utf8")); } catch { return undefined; }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
