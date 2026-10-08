import { describe, expect, it, vi } from "vitest";
import { newOntologyPackage, type OntologyActionType } from "@bim-studio/contracts";
import { createAiApi } from "../apiClients/aiApi";
import { buildOntologyActionPreviewInput, ontologyActionDefaultArguments, ontologyActionTargetIds } from "./ontologyActionPreviewInput";

function fixture() {
  const pkg = newOntologyPackage("manufacturing", "author");
  pkg.id = "line-a";
  const action: OntologyActionType = { id: "inspect", key: "inspect", label: "Inspect", boundObject: "Machine", inputSchema: { type: "object", required: ["plan"] }, outputSchema: {},
    toolBinding: { kind: "capability", id: "data.query.read", version: "1.0.0" }, preconditions: [], effect: "read", riskLevel: "low", approvalRequired: false, idempotencyRequired: false,
    impactScope: ["Machine"], authorizedScopes: ["project:read"], evidenceRequired: true, status: "published", version: 1 };
  pkg.objects = [{ id: "machine", key: "Machine", label: "Machine", domain: "manufacturing", primaryKeys: ["machine_id"], properties: [], sourceBindings: [], aliases: [],
    identityMappings: [{ objectKey: "Machine", canonicalId: "LINE-42", sources: [] }], status: "published", version: 1, owner: "author" }];
  return { pkg, action };
}

describe("ontology action preview input", () => {
  it("sends the actual package, registered instance and complete nested plan through the existing API consumer", async () => {
    const { pkg, action } = fixture();
    const plan = { datasetId: "line-state", fingerprint: "server-plan", fields: ["temperature"], filters: [{ field: "machine_id", operator: "eq", value: "LINE-42" }] };
    const body = buildOntologyActionPreviewInput(pkg, action, " LINE-42 ", JSON.stringify({ plan }));
    const request = vi.fn(async () => ({ executable: true }));
    const api = createAiApi(request as never, vi.fn() as never);
    await api.previewOntologyAction("project-a", body);
    expect(request.mock.calls[0]).toEqual(["/api/projects/project-a/ai/ontology-actions/preview", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ packageId: "line-a", actionKey: "inspect", target: { objectKey: "Machine", canonicalId: "LINE-42" }, arguments: { plan } }),
    }]);
  });
  it("does not substitute a type identifier for an instance or accept unregistered identities", () => {
    const { pkg, action } = fixture();
    expect(ontologyActionTargetIds(pkg, action)).toEqual(["LINE-42"]);
    expect(() => buildOntologyActionPreviewInput(pkg, action, "ontology:line-a:Machine", "{}")).toThrow("identity-unregistered");
    expect(() => buildOntologyActionPreviewInput(pkg, action, "", "{}")).toThrow("identity-invalid");
  });
  it.each(["null", "[]", "123", '"text"'])("rejects non-object parameters %s", parameters => {
    const { pkg, action } = fixture();
    expect(() => buildOntologyActionPreviewInput(pkg, action, "LINE-42", parameters)).toThrow("parameters-not-object");
  });
  it("rejects malformed JSON before requesting a preview", () => {
    const { pkg, action } = fixture();
    expect(() => buildOntologyActionPreviewInput(pkg, action, "LINE-42", "{")).toThrow("json-invalid");
  });
  it("supports explicit author input for an unmapped object and schema defaults", () => {
    const { pkg, action } = fixture();
    pkg.objects[0]!.identityMappings = [];
    action.inputSchema.default = { batch: 4 };
    expect(ontologyActionTargetIds(pkg, action)).toEqual([]);
    expect(buildOntologyActionPreviewInput(pkg, action, "MANUAL-9", ontologyActionDefaultArguments(action)).arguments).toEqual({ batch: 4 });
  });
  it("uses object identity mappings ahead of the package's unrelated identities", () => {
    const { pkg, action } = fixture();
    pkg.identityMappings = [{ objectKey: "Machine", canonicalId: "OTHER", sources: [] }];
    expect(ontologyActionTargetIds(pkg, action)).toEqual(["LINE-42"]);
    pkg.objects[0]!.identityMappings = [];
    expect(ontologyActionTargetIds(pkg, action)).toEqual(["OTHER"]);
  });
});
