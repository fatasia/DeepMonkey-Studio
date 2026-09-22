import { assertPathSafeResourceId } from "@bim-studio/contracts";

export interface ConversionTaskLease {
  taskId: string;
  ownerId: string;
  epoch: string;
  expiresAt: string;
  cancelRequested?: boolean;
}
export const CONVERSION_LEASE_TTL_MS = 30000;
export const CONVERSION_LEASE_SCHEMA = `CREATE TABLE IF NOT EXISTS bim_studio_conversion_leases (
  task_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, epoch BIGINT NOT NULL CHECK(epoch > 0), lease_until TIMESTAMPTZ NOT NULL,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE);
  ALTER TABLE bim_studio_conversion_leases ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE`;
const literal = (value: string) => `convert_from(decode('${Buffer.from(value).toString("base64")}', 'base64'), 'UTF8')`;
const result = "json_build_object('taskId', task_id, 'ownerId', owner_id, 'epoch', epoch::text, 'expiresAt', lease_until, 'cancelRequested', cancel_requested)::text";

export function requestCancellationSql(taskId: string): string {
  assertPathSafeResourceId(taskId, "taskId");
  return `WITH changed AS (UPDATE bim_studio_conversion_leases SET cancel_requested=TRUE
    WHERE task_id=${literal(taskId)} AND lease_until>clock_timestamp() RETURNING task_id)
    SELECT EXISTS(SELECT 1 FROM changed)`;
}

export function leaseSql(taskId: string, ownerId: string, action: "acquire" | "renew" | "release", epoch?: string): string {
  assertPathSafeResourceId(taskId, "taskId");
  assertPathSafeResourceId(ownerId, "ownerId");
  const task = literal(taskId), owner = literal(ownerId);
  if (action === "acquire") return `WITH changed AS (
    INSERT INTO bim_studio_conversion_leases(task_id,owner_id,epoch,lease_until)
    VALUES(${task},${owner},1,clock_timestamp()+interval '30 seconds')
    ON CONFLICT(task_id) DO UPDATE SET owner_id=EXCLUDED.owner_id, epoch=bim_studio_conversion_leases.epoch+1,
      lease_until=clock_timestamp()+interval '30 seconds'
    WHERE bim_studio_conversion_leases.lease_until<=clock_timestamp() RETURNING *) SELECT ${result} FROM changed`;
  if (!epoch || !/^[1-9][0-9]*$/.test(epoch) || BigInt(epoch) > 9223372036854775807n) throw new Error("转换租约 epoch 无效");
  const until = action === "renew" ? "clock_timestamp()+interval '30 seconds'" : "clock_timestamp()";
  return `WITH changed AS (UPDATE bim_studio_conversion_leases SET lease_until=${until}
    WHERE task_id=${task} AND owner_id=${owner} AND epoch=${epoch} AND lease_until>clock_timestamp()
    RETURNING *) SELECT ${result} FROM changed`;
}

export function leaseWriteFence(taskId: string, lease: ConversionTaskLease | undefined, recovery: boolean, publishing = false): string {
  assertPathSafeResourceId(taskId, "taskId");
  const task = literal(taskId);
  if (!lease) return `NOT EXISTS(SELECT 1 FROM bim_studio_conversion_leases WHERE task_id=${task}${recovery ? " AND lease_until>clock_timestamp()" : ""})`;
  if (lease.taskId !== taskId) throw new Error("转换租约与任务不一致");
  assertPathSafeResourceId(lease.ownerId, "ownerId");
  if (!/^[1-9][0-9]*$/.test(lease.epoch) || BigInt(lease.epoch) > 9223372036854775807n) throw new Error("转换租约 epoch 无效");
  // 与接管/释放锁同一行；等待锁后 PostgreSQL 重新检查 owner/epoch，旧快照不能越过 fencing。
  return `EXISTS(SELECT 1 FROM bim_studio_conversion_leases WHERE task_id=${task} AND owner_id=${literal(lease.ownerId)} AND epoch=${lease.epoch} AND lease_until>clock_timestamp()${publishing ? " AND NOT cancel_requested" : ""} FOR UPDATE)`;
}

export function parseConversionLease(value: string): ConversionTaskLease | undefined {
  if (!value.trim()) return undefined;
  const lease = JSON.parse(value) as ConversionTaskLease;
  leaseWriteFence(lease.taskId, lease, false);
  if (typeof lease.expiresAt !== "string" || !Number.isFinite(Date.parse(lease.expiresAt))) throw new Error("转换租约到期时间无效");
  return lease;
}
