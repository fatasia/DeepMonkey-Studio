import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertProductionStorage,
  loadProductionEnvironment,
  minioEnvironment,
  option,
  postgresArguments,
  postgresEnvironment,
  productionTools,
  randomSecret,
  repositoryRoot,
  runNative,
  safeIdentifier,
  upsertEnvironmentValue,
  writeAtomic,
} from "./lib/nativeProductionOps.mjs";

const confirmation = "PROVISION-DEDICATED-SERVICE-ACCOUNTS";
if (option("--confirm") !== confirmation) throw new Error(`必须显式传入 --confirm ${confirmation}`);
const { envPath, values } = loadProductionEnvironment();
assertProductionStorage(values);
const tools = productionTools(values);
const database = safeIdentifier(values.POSTGRES_DATABASE ?? "bim_studio", "数据库名称");
const postgresUser = safeIdentifier(option("--postgres-user", "bim_studio_app"), "PostgreSQL 服务账号");
const postgresPassword = randomSecret(32);
const minioAccessKey = `studio-${randomSecret(12).replace(/[^A-Za-z0-9]/g, "").slice(0, 16)}`;
const minioSecretKey = `S${randomSecret(32)}`;
const minioAlias = "bimprovision";
const bucket = values.MINIO_BUCKET ?? "bim-studio";

await provisionPostgres();
let minioUserCreated = false;
try {
  const adminEnvironment = minioEnvironment(values, minioAlias);
  await runNative(tools.mc, ["admin", "user", "add", minioAlias, minioAccessKey, minioSecretKey], {
    env: adminEnvironment,
    redact: [minioSecretKey],
  });
  minioUserCreated = true;
  await runNative(tools.mc, ["admin", "policy", "attach", minioAlias, "readwrite", "--user", minioAccessKey], { env: adminEnvironment });
  await runNative(tools.mc, ["stat", "--quiet", `${minioAlias}/${bucket}`], {
    env: minioEnvironment(values, minioAlias, { accessKey: minioAccessKey, secretKey: minioSecretKey }),
  });

  const current = await readFile(envPath, "utf8");
  const updated = [
    ["POSTGRES_USER", postgresUser],
    ["POSTGRES_PASSWORD", postgresPassword],
    ["MINIO_ACCESS_KEY", minioAccessKey],
    ["MINIO_SECRET_KEY", minioSecretKey],
  ].reduce((text, [key, value]) => upsertEnvironmentValue(text, key, value), current);
  const id = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const recoveryPath = path.resolve(option("--recovery-file", path.join(repositoryRoot, "data", "secrets", `service-accounts-${id}.env`)));
  await writeAtomic(recoveryPath, [
    `POSTGRES_USER=${postgresUser}`,
    `POSTGRES_PASSWORD=${postgresPassword}`,
    `MINIO_ACCESS_KEY=${minioAccessKey}`,
    `MINIO_SECRET_KEY=${minioSecretKey}`,
    `POSTGRES_MAINTENANCE_USER=${values.POSTGRES_USER ?? "postgres"}`,
    `POSTGRES_MAINTENANCE_PASSWORD=${values.POSTGRES_PASSWORD}`,
    `MINIO_MAINTENANCE_ACCESS_KEY=${values.MINIO_ACCESS_KEY}`,
    `MINIO_MAINTENANCE_SECRET_KEY=${values.MINIO_SECRET_KEY}`,
    "",
  ].join("\n"));
  await copyFile(envPath, `${envPath}.before-service-account-rotation`);
  await writeAtomic(envPath, updated);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    updatedEnvironment: envPath,
    recoveryPath,
    previousConfiguration: `${envPath}.before-service-account-rotation`,
    restartRequired: true,
    oldInfrastructureAccountsRemoved: false,
  }, null, 2)}\n`);
} catch (error) {
  if (minioUserCreated) {
    await runNative(tools.mc, ["admin", "user", "remove", minioAlias, minioAccessKey], {
      env: minioEnvironment(values, minioAlias),
    }).catch(() => undefined);
  }
  throw error;
}

async function provisionPostgres() {
  const sql = `
DO $provision$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${postgresUser}') THEN
    ALTER ROLE ${postgresUser} WITH LOGIN PASSWORD '${postgresPassword}';
  ELSE
    CREATE ROLE ${postgresUser} WITH LOGIN PASSWORD '${postgresPassword}';
  END IF;
END $provision$;
GRANT CONNECT ON DATABASE ${database} TO ${postgresUser};
GRANT USAGE, CREATE ON SCHEMA public TO ${postgresUser};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${postgresUser};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${postgresUser};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${postgresUser};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${postgresUser};
`;
  await runNative(tools.psql, [...postgresArguments(values), "-X", "-v", "ON_ERROR_STOP=1"], {
    env: postgresEnvironment(values),
    stdin: sql,
  });
  await runNative(tools.psql, [...postgresArguments({ ...values, POSTGRES_USER: postgresUser }, database), "-X", "-t", "-A", "-c", "SELECT COUNT(*) FROM bim_studio_state"], {
    env: postgresEnvironment(values, postgresPassword),
  });
}
