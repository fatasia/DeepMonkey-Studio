import type { DataConnectionRecord } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { createSqlConnectionProbe } from "./dataConnectionProbe.js";

function connection(type: DataConnectionRecord["type"]): DataConnectionRecord {
  return { id: "connection", projectId: "project", name: "现场库", type, enabled: true, config: {}, createdAt: "", updatedAt: "" };
}

describe("createSqlConnectionProbe", () => {
  it("uses a harmless query so SQL connections can be tested before a dataset exists", () => {
    expect(createSqlConnectionProbe(connection("postgresql"), "project")?.query).toBe("SELECT 1 AS connection_test");
    expect(createSqlConnectionProbe(connection("oracle"), "project")?.query).toContain("FROM dual");
  });

  it("does not invent a query for connectors that require a user-selected source", () => {
    expect(createSqlConnectionProbe(connection("mongodb"), "project")).toBeUndefined();
  });
});
