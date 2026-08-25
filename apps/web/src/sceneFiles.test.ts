import { describe, expect, it } from "vitest";
import dashboardFixture from "../../../test-fixtures/scene-v1-dashboard.json";
import interactionFixture from "../../../test-fixtures/scene-v1-interaction.json";
import pure3dFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { parseScene } from "./sceneFiles.js";

const fixtures = [pure3dFixture, dashboardFixture, interactionFixture];

describe("loose scene file compatibility", () => {
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))
    ("imports v1 fixture %s without changing it", (_id, fixture) => {
      expect(parseScene(JSON.stringify(fixture))).toEqual(fixture);
    });

  it("rejects unsupported scene file versions", () => {
    expect(() => parseScene(JSON.stringify({ ...pure3dFixture, schemaVersion: 2 })))
      .toThrow("不支持的场景文件版本");
  });
});
