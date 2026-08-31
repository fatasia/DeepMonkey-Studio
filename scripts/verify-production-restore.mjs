import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  assertProductionStorage,
  inventoryDirectory,
  loadProductionEnvironment,
  minioEnvironment,
  minioMaintenanceCredentials,
  option,
  postgresArguments,
  postgresEnvironment,
  postgresMaintenanceValues,
  productionTools,
  repositoryRoot,
  runNative,
  safeIdentifier,
  sha256File,
} from "./lib/nativeProductionOps.mjs";

const input = path.resolve(option("--input", ""));
if (!option("--input") || !existsSync(input)) throw new Error("必须提供存在的 --input 备份目录");
const manifest = JSON.parse(await readFile(path.join(input, "manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1 || !manifest.backupId) throw new Error("备份清单版本无效");
if (existsSync(path.join(input, ".incomplete"))) throw new Error("备份包含 .incomplete 标记");

const { values } = loadProductionEnvironment();
assertProductionStorage(values);
const tools = productionTools(values);
const maintenance = postgresMaintenanceValues(values);
const suffix = Math.random().toString(36).slice(2, 10);
const database = safeIdentifier(`bim_restore_verify_${suffix}`, "验证数据库");
const bucket = `bim-restore-verify-${suffix}`;
const alias = "bimverify";
const verificationDirectory = path.join(repositoryRoot, "data", "restore-verification", suffix);
const databaseDump = path.join(input, "postgres.dump");
const objectsDirectory = path.join(input, "objects");

if (await sha256File(databaseDump) !== manifest.postgres.sha256) throw new Error("PostgreSQL 备份摘要不一致");
await mkdir(verificationDirectory, { recursive: true });
let databaseCreated = false;
let bucketCreated = false;
let result;

try {
  await runPsql(`CREATE DATABASE ${database} ENCODING 'UTF8';`);
  databaseCreated = true;
  await runNative(tools.pgRestore, [
    ...postgresArguments(maintenance, database),
    "--no-owner", "--no-privileges", "--exit-on-error", databaseDump,
  ], { env: postgresEnvironment(maintenance) });
  const stateRows = (await runNative(tools.psql, [
    ...postgresArguments(maintenance, database), "-X", "-t", "-A", "-c", "SELECT COUNT(*) FROM bim_studio_state",
  ], { env: postgresEnvironment(maintenance) })).trim();

  const minioEnv = minioEnvironment(values, alias, minioMaintenanceCredentials(values));
  await runNative(tools.mc, ["mb", "--ignore-existing", `${alias}/${bucket}`], { env: minioEnv });
  bucketCreated = true;
  await runNative(tools.mc, ["mirror", "--overwrite", objectsDirectory, `${alias}/${bucket}`], { env: minioEnv });
  await runNative(tools.mc, ["mirror", "--overwrite", `${alias}/${bucket}`, verificationDirectory], { env: minioEnv });
  const restoredObjects = await inventoryDirectory(verificationDirectory);
  verifyInventory(restoredObjects, manifest.minio.objects);
  result = {
    ok: true,
    backupId: manifest.backupId,
    postgresStateRows: Number(stateRows),
    restoredObjects: restoredObjects.length,
  };
} finally {
  const cleanupErrors = [];
  if (databaseCreated) {
    await runPsql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}'; DROP DATABASE IF EXISTS ${database};`)
      .catch((error) => cleanupErrors.push(error));
  }
  if (bucketCreated) {
    const minioEnv = minioEnvironment(values, alias, minioMaintenanceCredentials(values));
    await runNative(tools.mc, ["rb", "--force", `${alias}/${bucket}`], { env: minioEnv })
      .catch((error) => cleanupErrors.push(error));
  }
  await rm(verificationDirectory, { recursive: true, force: true });
  if (cleanupErrors.length > 0) throw new Error(`恢复沙箱清理失败：${cleanupErrors.map(message).join("；")}`);
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function runPsql(statement) {
  return runNative(tools.psql, [...postgresArguments(maintenance, "postgres"), "-X", "-v", "ON_ERROR_STOP=1"], {
    env: postgresEnvironment(maintenance),
    stdin: statement,
  });
}

function verifyInventory(actual, expected) {
  if (actual.length !== expected.length) throw new Error("沙箱恢复后的 MinIO 对象数量不一致");
  for (let index = 0; index < expected.length; index += 1) {
    const item = actual[index];
    const target = expected[index];
    if (!item || item.path !== target.path || item.bytes !== target.bytes || item.sha256 !== target.sha256) {
      throw new Error(`沙箱恢复后的对象摘要不一致：${target.path}`);
    }
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
