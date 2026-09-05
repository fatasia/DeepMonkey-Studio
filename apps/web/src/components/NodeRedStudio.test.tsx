import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NODE_RED_DASHBOARD_PATH, NODE_RED_EDITOR_PATH, NODE_RED_HTTP_INGRESS_PATH, NODE_RED_WEBSOCKET_PATH, NodeRedStudio, nodeRedGatewayUrls } from "./NodeRedStudio";

describe("NodeRedStudio", () => {
  it("defers the editor iframe until health confirms Node-RED is online (no white screen)", () => {
    // 健康检查未返回前（SSR/静态渲染不跑 effect），iframe 不得指向 /node-red/，避免离线白屏。
    const html = renderToStaticMarkup(<NodeRedStudio locale="zh-CN" />);

    expect(html).not.toContain(`src="${NODE_RED_EDITOR_PATH}"`);
    expect(html).not.toContain("<iframe");
    expect(html).toContain("正在检查 Node-RED 服务");
    expect(html).toContain(`href="${NODE_RED_DASHBOARD_PATH}"`);
    expect(html).toContain("独立运行时");
    expect(html).toContain("不等同于平台内置的轻量数据流水线");
    expect(html).toContain(NODE_RED_HTTP_INGRESS_PATH);
    expect(html).toContain(NODE_RED_WEBSOCKET_PATH);
    expect(html).toContain("MQTT、TCP、UDP");
    expect(html).toContain("Kafka 连接器仍由平台原生维护");
  });

  it("builds copyable HTTP and WebSocket gateway URLs for either transport security mode", () => {
    expect(nodeRedGatewayUrls("https://studio.example.test:8443")).toEqual({
      httpIngress: "https://studio.example.test:8443/iot/scene",
      websocketConsumer: "wss://studio.example.test:8443/iot/ws/scene"
    });
    expect(nodeRedGatewayUrls("http://localhost:5173").websocketConsumer).toBe("ws://localhost:5173/iot/ws/scene");
  });
});
