import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationsService } from "../operations.js";
import { createIndustrialCapabilityHost, registerIndustrialCapabilityRoutes } from "../industrialCapabilities.js";
import { registerMcpCapabilityRoute } from "../mcpCapabilityAdapter.js";
import { createApiServer } from "../serverOptions.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

/** H-C1 验收：两个假设 harness 能力经 MCP tools/list 暴露，tools/call 返回 structuredContent。 */
describe("simulation hypothesis capabilities over MCP", () => {
  it("tools/list 暴露两个能力，tools/call 登记假设返回 structuredContent.proposalFingerprint", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-hypothesis-mcp-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const operations = new OperationsService(directory);
    await operations.init();
    const host = await createIndustrialCapabilityHost(operations);
    const app = createApiServer();
    await registerIndustrialCapabilityRoutes(app, { store: { getProject: () => ({ id: "project-1" }) } as never, host });
    await registerMcpCapabilityRoute(app, { host, store: { getProject: () => ({ id: "project-1" }) } as never });

    const listed = await app.inject({ method: "POST", url: "/api/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(listed.statusCode).toBe(200);
    const toolNames = (listed.json().result.tools as Array<{ name: string }>).map((tool) => tool.name);
    expect(toolNames).toContain("industrial.simulation.hypothesis.register");
    expect(toolNames).toContain("industrial.simulation.golden.verify");

    const called = await app.inject({
      method: "POST",
      url: "/api/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "industrial.simulation.hypothesis.register",
          arguments: {
            projectId: "project-1",
            input: {
              hypothesis: {
                hypothesisVersion: "1",
                id: "hyp-mcp-positive",
                statement: "校准场景中传感器单元利用率低于 0.3",
                targetModel: "t23-conveyor-sensor-agv",
                prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
                tolerance: { absolute: 0.05 },
              },
            },
          },
        },
      },
    });
    expect(called.statusCode).toBe(200);
    const structured = called.json().result.structuredContent as {
      status: string;
      capabilityId: string;
      output?: { proposalFingerprint?: string; execution?: string };
      evidence?: Array<{ fingerprint?: string }>;
    };
    expect(structured.status).toBe("completed");
    expect(structured.capabilityId).toBe("simulation.hypothesis.register");
    expect(structured.output?.proposalFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(structured.output?.execution).toBe("not-performed");
    expect(structured.evidence?.[0]?.fingerprint).toBe(structured.output?.proposalFingerprint);
    await app.close();
  });

  it("tools/call 校准验证返回 verdict=confirmed 的 structuredContent，非法假设 fail-closed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-hypothesis-mcp-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const operations = new OperationsService(directory);
    await operations.init();
    const host = await createIndustrialCapabilityHost(operations);
    const app = createApiServer();
    await registerIndustrialCapabilityRoutes(app, { store: { getProject: () => ({ id: "project-1" }) } as never, host });
    await registerMcpCapabilityRoute(app, { host, store: { getProject: () => ({ id: "project-1" }) } as never });

    const verified = await app.inject({
      method: "POST",
      url: "/api/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "industrial.simulation.golden.verify",
          arguments: {
            projectId: "project-1",
            input: {
              hypothesis: {
                hypothesisVersion: "1",
                id: "hyp-mcp-verify",
                statement: "校准场景中传感器单元利用率低于 0.3",
                targetModel: "t23-conveyor-sensor-agv",
                prediction: { metric: "resource-utilization", resourceId: "sensor-unit", comparator: "less-than", expected: 0.3 },
                tolerance: { absolute: 0.05 },
              },
            },
          },
        },
      },
    });
    expect(verified.statusCode).toBe(200);
    const envelope = (verified.json().result.structuredContent as { output?: Record<string, unknown> }).output ?? {};
    expect(envelope.verdict).toBe("confirmed");
    expect(envelope.reasonCode).toBe("prediction-within-tolerance");
    expect(Object.keys(envelope)).toEqual(expect.arrayContaining(["proposalFingerprint", "inputFingerprint", "resultFingerprint"]));

    const invalid = await app.inject({
      method: "POST",
      url: "/api/mcp",
      payload: {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "industrial.simulation.golden.verify",
          arguments: {
            projectId: "project-1",
            input: { hypothesis: { hypothesisVersion: "1", id: "bad" } },
          },
        },
      },
    });
    const invalidResult = invalid.json().result as { isError?: boolean; structuredContent?: { status?: string; warnings?: string[] } };
    expect(invalidResult.isError).toBe(true);
    expect(invalidResult.structuredContent?.status).toBe("blocked");
    await app.close();
  });
});
