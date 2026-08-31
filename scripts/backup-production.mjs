import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  apiReachable,
  assertProductionStorage,
  hasFlag,
  inventoryDirectory,
  loadProductionEnvironment,
  minioEnvironment,
  option,
  postgresArguments,
  postgresEnvironment,
  productionTools,
  repositoryRoot,
  runNative,
  sha256File,
  writeAtomic,
} from "./lib/nativeProductionOps.mjs";

const { values } = loadProductionEnvironment();
assertProductionStorage(values);
const tools = productionTools(values);
const backupId = option("--id", timestampId());
const output = path.resolve(option("--output", path.join(repositoryRoot, "data", "backups", backupId)));
const allowLive = hasFlag("--allow-live");

if (existsSync(output) && (await readdir(output)).length > 0) {
  throw new Error(`备份目录必须为空，避免旧对象混入新恢复点：${output}`);
}

if (await apiReachable(values) && !allowLive) {
  throw new Error("API 正在运行。请先执行 pnpm deploy:cloud:stop，或仅为非一致性审计显式传入 --allow-live");
}

const databaseDump = path.join(output, "postgres.dump");
const objectsDirectory = path.join(output, "objects");
const incompleteMarker = path.join(output, ".incomplete");
await mkdir(objectsDirectory, { recursive: true });
await writeFile(incompleteMarker, "backup in progress\n", "utf8");

try {
  await runNative(tools.pgDump, [
    ...postgresArguments(values),
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    "--file", databaseDump,
  ], { env: postgresEnvironment(values) });

  const alias = "bimbackup";
  const bucket = values.MINIO_BUCKET ?? "bim-studio";
  await runNative(tools.mc, ["mirror", "--overwrite", `${alias}/${bucket}`, objectsDirectory], {
    env: minioEnvironment(values, alias),
  });

  const objects = await inventoryDirectory(objectsDirectory);
  const manifest = {
    schemaVersion: 1,
    backupId,
    createdAt: new Date().toISOString(),
    consistency: allowLive ? "best-effort-live" : "application-stopped",
    postgres: {
      database: values.POSTGRES_DATABASE ?? "bim_studio",
      sha256: await sha256File(databaseDump),
    },
    minio: {
      bucket,
      objectCount: objects.length,
      bytes: objects.reduce((sum, item) => sum + item.bytes, 0),
      objects,
    },
  };
  await writeAtomic(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(incompleteMarker, { force: true });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    backupId,
    consistency: manifest.consistency,
    output,
    objectCount: manifest.minio.objectCount,
    objectBytes: manifest.minio.bytes,
  }, null, 2)}\n`);
} catch (error) {
  throw new Error(`备份未完成，已保留 .incomplete 标记：${error instanceof Error ? error.message : String(error)}`);
}

function timestampId() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}
