import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SceneDataBindingState } from "@bim-studio/contracts";
import { SceneDataBindingEditor } from "./SceneDataBindingEditor";

vi.mock("../api", () => ({ api: { listDatasets: vi.fn(), listDataPipelines: vi.fn() } }));
vi.mock("../directBindingRuntime", () => ({ testDirectBinding: vi.fn() }));

describe("SceneDataBindingEditor direct source", () => {
  it("keeps direct HTTP/WebSocket editing available without a Data Hub catalog", () => {
    const html = renderToStaticMarkup(<SceneDataBindingEditor
      locale="zh-CN"
      projectId="project-1"
      sceneId="scene-1"
      target={{ modelId: "robot-1" }}
      targetName="机器人 1"
      bindings={[directBinding()]}
      runtimeStates={{}}
      onChange={() => undefined}
      onTest={() => undefined}
      onOpenData={() => undefined}
    />);

    expect(html).toContain("直接 HTTP / WebSocket");
    expect(html).toContain("上游地址");
    expect(html).toContain("服务端凭据引用");
    expect(html).toContain("添加直接接口");
  });
});

function directBinding(): SceneDataBindingState {
  return {
    id: "direct-1", name: "机器人在线状态", enabled: true, field: "online",
    directBinding: { version: 1, gateway: "server", transport: "http", endpoint: "https://api.example/status", http: { method: "GET", refresh: { intervalMs: 5_000 } } },
    target: { modelId: "robot-1" }, action: "visibility", refreshSeconds: 5
  };
}
