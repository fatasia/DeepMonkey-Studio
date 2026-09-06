import { describe, expect, it } from "vitest";
import { isRecoverableStudioRead } from "./studioReadRecovery";

describe("studio read recovery allowlist", () => {
  it.each(["/api/projects", "/api/projects/p1", "/api/projects/p1/scenes", "/api/projects/p1/assets",
    "/api/projects/p1/applications", "/api/projects/p1/applications/a1", "/api/projects/p1/scenes/s1/publications", "/api/scenes/s1/browse"])
    ("allows only the explicit catalog/snapshot read %s", path => expect(isRecoverableStudioRead(path)).toBe(true));
  it.each(["/api/auth/me", "/api/auth/login", "/api/ai/assistant", "/api/projects/p1/scenes/s1/publish",
    "/api/projects/p1/scenes/import", "/api/projects/p1/datasets", "/api/projects/p1/vision/sources", "/api/admin/health",
    "/api/projects/p1/applications/a1/publish", "/api/projects/p1/assets/images", "/api/projects/p1/script-git/push"])
    ("does not expand retries to %s", path => expect(isRecoverableStudioRead(path)).toBe(false));
});
