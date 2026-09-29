import { describe, expect, it } from "vitest";
import { createAssistantSessionApi } from "./assistantSessionApi";

const input = { sequence: 2, question: "检查泵", answer: "运行正常", mode: "scene" as const, status: "streaming" as const };

function fakeRequest() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const request = async <T,>(url: string, init?: RequestInit): Promise<T> => {
    calls.push({ url, init });
    return { id: "m1", updatedAt: "" } as T;
  };
  return { request, calls };
}

describe("assistant session api (K12 conditional writes)", () => {
  it("sends the conditional If-Match header on message saves when a server version is known", async () => {
    const { request, calls } = fakeRequest();
    const api = createAssistantSessionApi(request);
    await api.saveAssistantSessionMessage("p1", "s1", "m1", input, '"v1"');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/projects/p1/ai/assistant-sessions/s1/messages/m1");
    expect(calls[0]!.init?.method).toBe("PUT");
    expect((calls[0]!.init?.headers as Record<string, string>)["if-match"]).toBe('"v1"');
  });

  it("omits the If-Match header for the first save of a message (create is unconditional)", async () => {
    const { request, calls } = fakeRequest();
    const api = createAssistantSessionApi(request);
    await api.saveAssistantSessionMessage("p1", "s1", "m1", input);
    await api.saveAssistantSessionMessage("p1", "s1", "m1", input, undefined);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect((call.init?.headers as Record<string, string>)["if-match"]).toBeUndefined();
      expect((call.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    }
  });
});
