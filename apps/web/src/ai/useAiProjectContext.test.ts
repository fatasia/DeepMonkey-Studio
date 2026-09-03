import type { PprBopVersion } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { summarizePprVersions } from "./useAiProjectContext";

describe("AI project context", () => {
  it("summarizes process-plan evidence without copying full work instructions", () => {
    const version: PprBopVersion = {
      id: "version-2",
      planId: "assembly-plan",
      version: "2.0",
      name: "总装提速方案",
      createdAt: "2026-09-04T00:00:00.000Z",
      basedOnVersionId: "version-1",
      targetTaktMinutes: 2.5,
      components: [{ id: "product", name: "产品", kind: "product" }],
      operations: [],
      precedenceRelations: [],
      resources: [],
      resourceAssignments: [],
      references: [{ kind: "scene", id: "line-a" }],
    };

    expect(summarizePprVersions([version])).toEqual([{
      id: "version-2",
      planId: "assembly-plan",
      version: "2.0",
      name: "总装提速方案",
      createdAt: "2026-09-04T00:00:00.000Z",
      basedOnVersionId: "version-1",
      targetTaktMinutes: 2.5,
      componentCount: 1,
      operationCount: 0,
      resourceCount: 0,
      assignmentCount: 0,
      externalReferenceCount: 1,
    }]);
  });

  it("caps prompt context to the latest twenty supplied versions", () => {
    const versions = Array.from({ length: 24 }, (_, index) => ({
      id: `version-${index}`,
      planId: "plan",
      version: String(index),
      name: `方案 ${index}`,
      createdAt: "2026-09-04T00:00:00.000Z",
      components: [],
      operations: [],
      precedenceRelations: [],
      resources: [],
      resourceAssignments: [],
    })) satisfies PprBopVersion[];

    const summarized = summarizePprVersions(versions);
    expect(summarized).toHaveLength(20);
    expect(summarized[0]?.id).toBe("version-4");
    expect(summarized.at(-1)?.id).toBe("version-23");
  });
});
