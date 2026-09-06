import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("recovery-collections");
const report = { bundleSha256: createHash("sha256").update(await readFile(new URL("../dist/index.html", import.meta.url))).digest("hex"), cases: [] };
console.log(JSON.stringify({ output: gate.output }));
async function draftRecord(page, draft, read = false) {
  return page.evaluate(({ draft, read }) => new Promise((resolve, reject) => {
    const request = indexedDB.open("bim-studio-recovery", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("workspace-drafts", { keyPath: "key" });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result, transaction = database.transaction("workspace-drafts", read ? "readonly" : "readwrite");
      const operation = read ? transaction.objectStore("workspace-drafts").get(draft.key) : transaction.objectStore("workspace-drafts").put(draft);
      let result; operation.onsuccess = () => { result = operation.result; };
      transaction.oncomplete = () => { database.close(); resolve(result ?? null); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }), { draft, read });
}
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [] }; report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage(); page.setDefaultTimeout(20000); observeDiagnostics(page, entry);
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${width}-${name}.png`) });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `旧快照集合-${round}-${theme}` });
      const { appPath, scenePath } = await createScene(gate, page, project.id);
      const application = await gate.json("GET", appPath);
      const { scene: snapshot } = await gate.json("GET", `/api/scenes/${application.scenes[0].id}/browse`);
      await page.goto(`${gate.origin}/manager?project=${project.id}`);
      const fields = ["annotations", "cameraViews", "assetBindings", "selectionSets", "interactions"];
      const expanded = structuredClone(snapshot); for (const field of fields) expanded[field] = [];
      const draft = { schemaVersion: 1, key: `${project.id}:${application.metadata.id}:${snapshot.id}`, projectId: project.id,
        applicationId: application.metadata.id, sceneId: snapshot.id, baseRevision: application.metadata.revision,
        savedAt: new Date(Date.now() + 1000).toISOString(), scene: expanded };
      await draftRecord(page, draft);
      const writes = []; page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/") && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(request.method() + " " + new URL(request.url()).pathname); });
      await page.goto(scenePath); await page.locator(".viewport canvas").waitFor();
      const recovery = page.getByRole("dialog", { name: "恢复未保存工作", exact: true });
      for (let attempt = 0; attempt < 50 && await draftRecord(page, draft, true); attempt++) await page.waitForTimeout(100);
      assert.equal(await recovery.count(), 0, "Equivalent empty collections must not show recovery");
      assert.equal(await draftRecord(page, draft, true), null, "Equivalent record should be cleared only after comparison");
      await shot("equivalent-no-dialog");
      await page.goto(`${gate.origin}/manager?project=${project.id}`);
      draft.scene.name = "真正未保存的名称"; draft.savedAt = new Date(Date.now() + 1000).toISOString();
      await draftRecord(page, draft); await page.goto(scenePath); await recovery.waitFor(); await shot("real-edit-preserved");
      await page.keyboard.press("Escape"); await recovery.waitFor({ state: "detached" });
      assert.equal((await draftRecord(page, draft, true)).scene.name, "真正未保存的名称");
      assert.deepEqual(await gate.json("GET", appPath), application); assert.deepEqual(writes, []); assert.deepEqual(entry.errors, []);
      entry.passed = true;
    } catch (error) { entry.failure = error.stack; await shot("failed"); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(item => item.passed) }));
