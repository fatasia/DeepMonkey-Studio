import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createApiServer } from "./serverOptions.js";
import { registerDashboardOfflineArchiveDownloadRoutes } from "./dashboardOfflineArchiveDownloadRoutes.js";

describe("dashboard download cancellation before archive allocation", () => {
  it.each(["offline-archive", "portable-zip", "standalone-executable"])(
    "does not build %s after disconnect during manifest lookup", async endpoint => {
      const app = createApiServer();
      app.addHook("preHandler", async request => {
        request.systemUser = { id: "editor", enabled: true, role: "editor", projectIds: ["project"] } as never;
      });
      let ready!: () => void, release!: () => void, finished!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const settled = new Promise<void>(resolve => { finished = resolve; });
      let signal: AbortSignal | undefined;
      app.addHook("onRoute", route => {
        const handler = route.handler;
        route.handler = async function(request, reply) {
          try { return await handler.call(this, request, reply); }
          finally { finished(); }
        };
      });
      const createArchive = vi.fn(() => ({ archive: "private" }) as never);
      const serializeArchive = vi.fn(() => Uint8Array.of(1));
      const packageBytes = vi.fn(async () => Uint8Array.of(2));
      await registerDashboardOfflineArchiveDownloadRoutes(app, {
        registry: { read: () => ({ summary: {}, candidate: { capability: {}, artifact: { artifact: Uint8Array.of(3) } } }) as never },
        readFreezeManifest: async input => {
          signal = input.signal; ready(); await blocked;
          // 模拟不响应取消的存储适配器，路由必须自行检查。
          return { manifest: "server-only" } as never;
        },
        createArchive, serializeArchive,
        portable: { nativeExecutable: path.resolve("test-player.exe"), createZip: packageBytes, createExecutable: packageBytes },
      });
      try {
        const origin = await app.listen({ host: "127.0.0.1", port: 0 });
        const controller = new AbortController();
        const download = fetch(`${origin}/api/projects/project/applications/application/dashboard-candidates/candidate/${endpoint}`,
          { signal: controller.signal }).catch(error => error);
        await started; controller.abort(); await download;
        await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 1000 });
        release();
        await settled;
        expect(createArchive).not.toHaveBeenCalled();
        expect(serializeArchive).not.toHaveBeenCalled();
        expect(packageBytes).not.toHaveBeenCalled();
      } finally { release(); await app.close(); }
    },
  );
});
