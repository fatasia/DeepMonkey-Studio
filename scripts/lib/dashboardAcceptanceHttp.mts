import assert from "node:assert/strict";
import type { ApplicationDocument, PublishedApplicationRecord } from "../../packages/contracts/src/index.ts";
import { createApiServer } from "../../apps/api/src/serverOptions.js";
import { registerApplicationRoutes } from "../../apps/api/src/applicationRoutes.js";
import type { JsonStore } from "../../apps/api/src/jsonStore.js";

/** Real loopback HTTP, using only the acceptance server's ephemeral address. */
export async function dashboardAcceptanceHttp(app: ReturnType<typeof createApiServer>) {
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  return async ({ method, url, payload, form }: { method: string; url: string; payload?: unknown; form?: FormData }) => {
    if (!url.startsWith("/api/") || url.startsWith("//")) throw new Error("Acceptance request must stay on its local API");
    if (form && payload !== undefined) throw new Error("Acceptance request cannot mix JSON and multipart bodies");
    const response = await fetch(`${origin}${url}`, { method,
      ...(form ? { body: form } : {}),
      ...(payload === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(90_000), redirect: "error" });
    const rawPayload = Buffer.from(await response.arrayBuffer());
    return { statusCode: response.status, headers: Object.fromEntries(response.headers), rawPayload,
      get body() { return rawPayload.toString("utf8"); }, json: () => JSON.parse(rawPayload.toString("utf8")) };
  };
}

export async function publishDashboardAcceptanceFixture(store: JsonStore, projectId: string, document: ApplicationDocument) {
  const app = createApiServer();
  try {
    await registerApplicationRoutes(app, store);
    const request = await dashboardAcceptanceHttp(app);
    const base = `/api/projects/${projectId}/applications`;
    const initial = structuredClone(document);
    initial.metadata.name = "Initial HTTP author draft";
    const created = await request({ method: "POST", url: base, payload: initial });
    assert.equal(created.statusCode, 201, created.body);
    const edited = structuredClone(document);
    edited.metadata.revision = created.json().metadata.revision;
    const saved = await request({ method: "PUT", url: `${base}/${document.metadata.id}`, payload: edited });
    assert.equal(saved.statusCode, 200, saved.body);
    const published = await request({ method: "POST", url: `${base}/${document.metadata.id}/publish` });
    assert.equal(published.statusCode, 201, published.body);
    const publication = published.json() as PublishedApplicationRecord;
    const publicRead = await request({ method: "GET", url: `/api/public/applications/${document.metadata.id}/revisions/${publication.id}` });
    assert.equal(publicRead.statusCode, 200, publicRead.body);
    assert.deepEqual(publicRead.json(), publication);
    return publication;
  } finally { await app.close(); }
}
