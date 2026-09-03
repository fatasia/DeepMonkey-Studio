import type { DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";

const SQL_PROBES: Partial<Record<DataConnectionRecord["type"], string>> = {
  postgresql: "SELECT 1 AS connection_test",
  mysql: "SELECT 1 AS connection_test",
  mariadb: "SELECT 1 AS connection_test",
  tidb: "SELECT 1 AS connection_test",
  doris: "SELECT 1 AS connection_test",
  starrocks: "SELECT 1 AS connection_test",
  sqlserver: "SELECT 1 AS connection_test",
  oracle: "SELECT 1 AS connection_test FROM dual",
  tdengine: "SELECT 1 AS connection_test",
  clickhouse: "SELECT 1 AS connection_test",
};

/** Creates a read-only query that verifies a database session without requiring a user table. */
export function createSqlConnectionProbe(
  connection: DataConnectionRecord,
  projectId: string,
): DataDatasetRecord | undefined {
  const query = SQL_PROBES[connection.type];
  if (!query) return undefined;
  const timestamp = new Date(0).toISOString();
  return {
    id: `probe:${connection.id}`,
    projectId,
    connectionId: connection.id,
    name: "连接探针",
    query,
    refreshSeconds: 0,
    fields: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
