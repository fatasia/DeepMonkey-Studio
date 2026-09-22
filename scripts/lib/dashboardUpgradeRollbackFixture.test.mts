import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDashboardDocument } from "../../packages/contracts/src/index.ts";
import { buildVersionDocument, V2, V3 } from "./dashboardUpgradeRollbackFixture.mts";

test("builds distinct valid upgrade-chain documents from the shared fixture", async () => {
  const [v2, v3] = await Promise.all([
    buildVersionDocument(V2, "project-upgrade-chain"),
    buildVersionDocument(V3, "project-upgrade-chain"),
  ]);

  assertDashboardDocument(v2);
  assertDashboardDocument(v3);
  assert.equal(v2.application.metadata.projectId, "project-upgrade-chain");
  assert.equal(v2.application.pages.length, 1);
  assert.equal(v2.application.pages[0]!.nodes.length, 5);
  assert.equal(v2.application.pages[0]!.appearance?.backgroundColor, V2.pageBackground);
  assert.equal(v3.application.pages[0]!.appearance?.backgroundColor, V3.pageBackground);
  assert.notEqual(v2.application.metadata.id, v3.application.metadata.id);
  assert.notDeepEqual(v2.application.pages[0]!.nodes, v3.application.pages[0]!.nodes);
});
