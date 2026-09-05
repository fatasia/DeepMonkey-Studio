import { describe, expect, it, vi } from "vitest";
import { createIndustrialApi } from "./industrialApi";

describe("industrial capability cancellation", () => {
  it("forwards the signal to the request without serializing it into the body", async () => {
    const request = vi.fn().mockResolvedValue({});
    const client = createIndustrialApi(request);
    const controller = new AbortController();
    await client.invokeCapability("p-1", "data.query.draft", { prompt: "温度趋势" }, "web-user", controller.signal);
    expect(request).toHaveBeenCalledWith("/api/projects/p-1/capabilities/invoke", expect.objectContaining({ signal: controller.signal }));
    expect(JSON.parse(request.mock.calls[0]?.[1].body)).toEqual({ capabilityId: "data.query.draft", principal: "web-user", input: { prompt: "温度趋势" } });
  });
});
