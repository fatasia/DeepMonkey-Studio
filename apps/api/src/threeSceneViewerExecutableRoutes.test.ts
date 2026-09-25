import { expect, it } from "vitest";
import { createApiServer } from "./serverOptions.js";
import { registerThreeSceneViewerExecutableRoutes } from "./threeSceneViewerExecutableRoutes.js";

it("keeps the installed route diagnostic instead of returning a misleading 404", async () => {
  const app = createApiServer();
  app.addHook("preHandler", async request => {
    request.systemUser = { id: "u", enabled: true, role: "admin", projectIds: [] } as never;
  });
  try {
    await registerThreeSceneViewerExecutableRoutes(app, { store: {} as never });
    const response = await app.inject({ method: "POST",
      url: "/api/projects/p/scenes/s/publications/1/three-webview-executable" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "THREE_WEBVIEW_LAUNCHER_UNAVAILABLE" });
  } finally { await app.close(); }
});
