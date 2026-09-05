import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("@bim-studio/server-sdk", () => ({ ServerClient: class { request = request; } }));
import { fetchNodeRedHealth } from "./api";

describe("Node-RED health transport", () => {
  beforeEach(() => { request.mockReset(); });
  it("uses the shared authenticated transport and propagates cancellation", async () => {
    const signal = new AbortController().signal;
    request.mockResolvedValue({ online: true });
    await expect(fetchNodeRedHealth(signal)).resolves.toEqual({ online: true });
    expect(request).toHaveBeenCalledWith("/api/node-red/health", { signal });
  });
  it("does not disguise authorization or network failures as confirmed service offline", async () => {
    request.mockRejectedValue(new Error("Unauthorized"));
    await expect(fetchNodeRedHealth()).rejects.toThrow("Unauthorized");
  });
});
