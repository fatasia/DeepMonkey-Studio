import { describe, expect, it, vi } from "vitest";
import { createAiAuditEvent } from "./aiReliabilityAudit.js";
import { createMetadataAiAuditSink } from "./metadataAiAuditSink.js";

describe("persistent AI audit sink", () => {
  it("maps fingerprint-only AI evidence into the existing audit store", async () => {
    const addAuditLog = vi.fn(async () => undefined);
    const sink = createMetadataAiAuditSink({ addAuditLog });
    const event = createAiAuditEvent({
      traceId: "trace-1", stage: "input-assessment", outcome: "denied", principal: "operator",
      projectId: "plant/1", providerId: "ai.test", inputFingerprint: "a".repeat(64),
    });
    await sink(event);
    expect(addAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      id: event.eventId, username: "operator", action: "ai.input-assessment.denied",
      resource: "/projects/plant%2F1/ai/ai.test", method: "AI", statusCode: 403,
    }));
    expect(addAuditLog.mock.calls[0]?.[0].detail).toContain(event.evidenceFingerprint);
    expect(addAuditLog.mock.calls[0]?.[0].detail).not.toContain("apiKey");
  });
});
