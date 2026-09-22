import type { DatabaseDocument } from "@bim-studio/contracts";

export class MetadataRevisionConflict extends Error {
  readonly statusCode = 409;
  readonly code = "metadata_revision_conflict";
  constructor() { super("元数据已被其他实例更新，请重新读取后重试"); }
}

export const READ_POSTGRES_STATE = "SELECT encode(convert_to(json_build_object('revision', revision::text, 'document', document)::text, 'UTF8'), 'base64') FROM bim_studio_state WHERE id = 1";

function assertRevision(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n) throw new Error("PostgreSQL 元数据版本无效");
}

export function parsePostgresState(encoded: string): { revision: string; document: DatabaseDocument } | undefined {
  if (!encoded.trim()) return undefined;
  const value = JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8"));
  assertRevision(value.revision);
  if (!value.document || typeof value.document !== "object" || Array.isArray(value.document) || !Array.isArray(value.document.projects)) throw new Error("PostgreSQL 元数据文档无效");
  return value;
}

/** 使用数据库行版本比较并提交，不能把冲突重试成无条件整文档覆盖。 */
export function postgresStateWrite(document: DatabaseDocument, expectedRevision: string | undefined, fence = "TRUE"): string {
  const encoded = Buffer.from(JSON.stringify(document), "utf8").toString("base64");
  const json = `convert_from(decode('${encoded}', 'base64'), 'UTF8')::jsonb`;
  if (expectedRevision === undefined) return `WITH saved AS (
    INSERT INTO bim_studio_state (id, document, revision, updated_at) SELECT 1, ${json}, 0, NOW() WHERE ${fence}
    ON CONFLICT (id) DO NOTHING RETURNING revision) SELECT revision::text FROM saved`;
  assertRevision(expectedRevision);
  return `WITH saved AS (UPDATE bim_studio_state SET document = ${json}, revision = revision + 1, updated_at = NOW()
    WHERE id = 1 AND revision = ${expectedRevision} AND (${fence}) RETURNING revision) SELECT revision::text FROM saved`;
}

export function acceptedPostgresRevision(result: string, expected: string | undefined): string | undefined {
  const revision = result.trim();
  if (!revision) return undefined;
  assertRevision(revision);
  if (BigInt(revision) !== (expected === undefined ? 0n : BigInt(expected) + 1n)) throw new Error("PostgreSQL 元数据提交版本不一致");
  return revision;
}
