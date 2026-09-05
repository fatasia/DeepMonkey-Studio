import { describe, expect, it } from "vitest";
import { createSemanticModelApi } from "./semanticModelApi";
import { newSemanticModel } from "../components/semanticModelEditorLogic";

describe("semantic model API", () => {
  it("reuses the authenticated request boundary and encodes every path ID", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const api = createSemanticModelApi(async <T,>(url: string, init?: RequestInit) => { requests.push({ url, init }); return {} as T; });
    const draft = newSemanticModel("dataset"); draft.id = "model/a";
    await api.listSemanticModels("project/a"); await api.createSemanticModel("project/a", draft);
    await api.updateSemanticModel("project/a", draft); await api.deleteSemanticModel("project/a", draft.id);
    expect(requests.map(item => item.init?.method ?? "GET")).toEqual(["GET", "POST", "PUT", "DELETE"]);
    expect(requests[0]?.url).toBe("/api/projects/project%2Fa/semantic-models");
    expect(requests[2]?.url).toBe("/api/projects/project%2Fa/semantic-models/model%2Fa");
    expect(JSON.parse(requests[1]?.init?.body as string)).toEqual(draft);
  });
});
