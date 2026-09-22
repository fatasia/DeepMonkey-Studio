import { describe, expect, it } from "vitest";
import { assistantContextDelivery } from "./assistantContextDelivery.js";

describe("assistant context delivery receipt", () => {
  it("measures nested value offsets even when escaped content repeats property names", () => {
    const context = { scene: { text: '\"models\": [1] 😀' }, platform: { vision: { models: [1, 2], events: [3] } } };
    const json = JSON.stringify(context);
    const boundary = json.indexOf("[1,2]") + 3;
    const receipt = assistantContextDelivery(context, context, boundary);
    expect(receipt.sources.find((source) => source.id === "workspace-scene")).toMatchObject({ status: "sent", transformed: false });
    expect(receipt.sources.find((source) => source.id === "vision-models")).toMatchObject({ status: "partial", preparedChars: 5, sentChars: 3 });
    expect(receipt.sources.find((source) => source.id === "vision-events")).toMatchObject({ status: "omitted", sentChars: 0 });
    expect(receipt.preparedChars).toBe(json.length);
  });

  it("reports preprocessing changes and removed sources without claiming full delivery", () => {
    const original = { scene: { label: "long" }, platform: { vision: { events: [1] } } };
    const prepared = { scene: { label: "lo" } };
    const receipt = assistantContextDelivery(original, prepared, JSON.stringify(prepared).length);
    expect(receipt.sources).toEqual([
      expect.objectContaining({ id: "workspace-scene", status: "partial", transformed: true }),
      expect.objectContaining({ id: "vision-events", status: "omitted", preparedChars: 0, sentChars: 0, transformed: true }),
    ]);
  });
});
