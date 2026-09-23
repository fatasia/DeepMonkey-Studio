import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteStore } from "./sqliteStore.js";

describe("SqliteStore", () => {
  it("persists the shared metadata document and reopens it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "bim-studio-sqlite-"));
    try {
      const store = new SqliteStore(directory);
      await store.init();
      const project = await store.createProject("SQLite 项目", "单机验证");
      const reopened = new SqliteStore(directory);
      await reopened.init();
      expect(reopened.getProject(project.id)?.name).toBe("SQLite 项目");
      expect(reopened.listProjects()).toHaveLength(2);
      expect(await readFile(path.join(directory, "database.sqlite"))).toBeTruthy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
