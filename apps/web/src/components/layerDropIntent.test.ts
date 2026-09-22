import { expect, it } from "vitest";
import { resolveLayerDropPosition } from "./layerDropIntent";

it("resolves row halves and group edges/center with viewport coordinates", () => {
  const rect = { top: 100, height: 40 };
  expect([101, 119, 120, 139].map(y => resolveLayerDropPosition("item", y, rect))).toEqual(["before", "before", "after", "after"]);
  expect([101, 110, 120, 130, 139].map(y => resolveLayerDropPosition("group", y, rect))).toEqual(["before", "inside", "inside", "inside", "after"]);
});
