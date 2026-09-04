import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  apiReachable,
  assertProductionStorage,
  inventoryDirectory,
  loadProductionEnvironment,
  minioEnvironment,
  option,
  postgresArguments,
  postgresEnvironment,
  postgresMaintenanceValues,
  productionTools,
  runNative,
  sha256File,
} from "./lib/nativeProductionOps.mjs";

const input = path.resolve(option("--input", ""));
if (!option("--input") || !existsSync(input)) throw new Error("必须提供存在的 --input 备份目录");
if (existsSync(path.join(input, ".incomplete"))) throw new Error("备份包含 .incomplete 标记，禁止恢复");

const manifest = JSON.parse(await readFile(path.join(input, "manifest.json"), "utf8"));
if (manifest.schemaVersion !== 1 || !manifest.backupId) throw new Error("备份清单版本无效");
if (option("--confirm") !== manifest.backupId) throw new Error(`恢复确认不匹配，请显式传入 --confirm ${manifest.backupId}`);

const databaseDump = path.join(input, "postgres.dump");
const objectsDirectory = path.join(input, "objects");
if (await sha256File(databaseDump) !== manifest.postgres.sha256) throw new Error("PostgreSQL 备份摘要不一致");
await verifyObjects(objectsDirectory, manifest.minio.objects);

const { values } = loadProductionEnvironment();
assertProductionStorage(values);
if (await apiReachable(values)) throw new Error("API 正在运行，恢复前必须执行 pnpm studio undeploy");
const tools = productionTools(values);
const maintenance = postgresMaintenanceValues(values);

await runNative(tools.pgRestore, [
  ...postgresArguments(maintenance),
  "--clean",
  "--if-exists",
  "--no-owner",
  "--no-privileges",
  "--exit-on-error",
  databaseDump,
], { env: postgresEnvironment(maintenance) });

const alias = "bimrestore";
const bucket = values.MINIO_BUCKET ?? "bim-studio";
await runNative(tools.mc, ["mirror", "--overwrite", "--remove", objectsDirectory, `${alias}/${bucket}`], {
  env: minioEnvironment(values, alias),
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  backupId: manifest.backupId,
  restoredDatabase: values.POSTGRES_DATABASE ?? "bim_studio",
  restoredBucket: bucket,
  objectCount: manifest.minio.objectCount,
}, null, 2)}\n`);

async function verifyObjects(directory, expected) {
  const actual = await inventoryDirectory(directory);
  if (actual.length !== expected.length) throw new Error("MinIO 对象数量与清单不一致");
  for (let index = 0; index < expected.length; index += 1) {
    const item = actual[index];
    const target = expected[index];
    if (!item || item.path !== target.path || item.bytes !== target.bytes || item.sha256 !== target.sha256) {
      throw new Error(`MinIO 对象摘要不一致：${target.path}`);
    }
    if ((await stat(path.join(directory, target.path))).size !== target.bytes) throw new Error(`MinIO 对象大小不一致：${target.path}`);
  }
}
