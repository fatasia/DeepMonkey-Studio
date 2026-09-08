import { describe, expect, it } from "vitest";
import { assertApplicationDocument } from "./application.js";
import { migrateSceneSnapshotV1 } from "./applicationMigration.js";
import type { SceneSnapshot } from "./scene.js";
import fixture from "../../../test-fixtures/scene-v1-pure-3d.json";

const source = { kind: "industry-pack", packId: "manufacturing-asset-ops", revision: 1, pageTemplateId: "production", instanceId: "pack:one" } as const;
function document(value?: unknown) {
  const app = migrateSceneSnapshotV1(fixture as SceneSnapshot);
  if (value !== undefined) app.pages[0]!.templateSource = value as never;
  return app;
}

describe("dashboard template provenance", () => {
  it("accepts legacy pages and preserves source after editable document round trip", () => {
    expect(() => assertApplicationDocument(document())).not.toThrow();
    const app = document(source);
    app.pages[0]!.name = "用户自己的标题";
    const reloaded = JSON.parse(JSON.stringify(app));
    expect(() => assertApplicationDocument(reloaded)).not.toThrow();
    expect(reloaded.pages[0].templateSource).toEqual(source);
  });
  it.each([null, {}, { ...source, kind: "remote-url" }, { ...source, revision: 0 }, { ...source, revision: 1.5 },
    { ...source, packId: "" }, { ...source, instanceId: "x".repeat(161) }, { ...source, pageTemplateId: "a\nb" }])("rejects malformed source %j", value => {
    expect(() => assertApplicationDocument(document(value))).toThrow();
  });
});
