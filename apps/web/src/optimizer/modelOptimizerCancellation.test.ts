import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { waitForOptimizerModel } from "./modelOptimizerAssets";

vi.mock("../api", () => ({ api: { getProject: vi.fn() } }));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
const ready = { models: [{ id: "model", status: "ready", message: "ready" }] } as Awaited<ReturnType<typeof api.getProject>>;

describe("optimizer conversion cancellation", () => {
  it("does not read a project for an already cancelled operation", async () => {
    vi.mocked(api.getProject).mockResolvedValue(ready);
    const controller = new AbortController(); controller.abort();
    const progress = vi.fn();
    await expect(waitForOptimizerModel("project", "model", progress, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(api.getProject).not.toHaveBeenCalled();
  });

  it("does not report late progress or return a project after cancellation", async () => {
    let release!: (project: typeof ready) => void;
    vi.mocked(api.getProject).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const controller = new AbortController(); const progress = vi.fn();
    const pending = waitForOptimizerModel("project", "model", progress, controller.signal);
    controller.abort(); release(ready);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).not.toHaveBeenCalled();
  });
});
