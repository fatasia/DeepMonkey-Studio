import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CloudRenderControlOverview } from "@bim-studio/server-sdk";
import { CloudRenderConfigurationWizard, CloudRenderControlView } from "./CloudRenderControl";

vi.mock("../api", () => ({ api: {} }));

const t = (zh: string) => zh;
const noop = () => undefined;

describe("CloudRenderControlView", () => {
  it("renders an explicit first-class configuration entry without persisting a secret", () => {
    const html = renderToStaticMarkup(<CloudRenderConfigurationWizard locale="zh-CN" configured={false} />);
    expect(html).toContain("云渲染设置");
    expect(html).toContain("Worker 地址");
    expect(html).toContain("访问令牌");
    expect(html).toContain("Public Origin");
    expect(html).toContain("高级部署设置");
    expect(html).toContain("CLOUD_RENDER_WORKER_TOKEN=&lt;secure-token&gt;");
    expect(html).toContain("/v1/health");
    expect(html).toContain("根地址应返回 200 服务信息");
    expect(html).toContain("测试连接");
  });

  it("shows verified RTP counters for a genuinely streaming session", () => {
    const html = renderToStaticMarkup(<CloudRenderControlView t={t} overview={overview()} onReload={noop} onEnableAndStart={noop} onStart={noop} onRefresh={noop} onStop={noop} onDisable={noop} />);
    expect(html).toContain("媒体已验证");
    expect(html).toContain("120 frames");
    expect(html).toContain("WebRTC outbound-rtp");
    expect(html).toContain("打开 Worker 观看端");
  });

  it("states missing Worker configuration instead of showing a fake running state", () => {
    const value = overview();
    value.configured = false;
    delete value.worker;
    value.missingRequirements = ["CLOUD_RENDER_WORKER_URL / CLOUD_RENDER_WORKER_TOKEN", "CLOUD_RENDER_PUBLIC_ORIGIN"];
    value.scenes[0]!.session = { ...value.scenes[0]!.session!, state: "signaling", mediaEvidence: undefined };
    const html = renderToStaticMarkup(<CloudRenderControlView t={t} overview={value} onReload={noop} onEnableAndStart={noop} onStart={noop} onRefresh={noop} onStop={noop} onDisable={noop} />);
    expect(html).toContain("真实 GPU Worker 尚未接入");
    expect(html).toContain("等待媒体证据");
    expect(html).toContain("打开观看端并建立媒体");
    expect(html).not.toContain("媒体已验证");
  });
});

function overview(): CloudRenderControlOverview {
  return {
    configured: true,
    missingRequirements: [],
    worker: {
      contractVersion: 1,
      workerId: "worker-1",
      status: "ready",
      observedAt: "2026-08-25T12:00:10.000Z",
      capacity: { maxSessions: 4, activeSessions: 1 },
      gpu: { vendor: "NVIDIA", model: "L40S", memoryMiB: 48_000, encoder: { hardware: true, codecs: ["h264"] } }
    },
    scenes: [{
      sceneId: "scene-1",
      projectId: "default",
      name: "工厂总览",
      publishedAt: "2026-08-25T12:00:00.000Z",
      enabled: true,
      publicationChanged: false,
      session: {
        sessionId: "session-1",
        workerSessionId: "worker-session-1",
        userId: "admin-1",
        projectId: "default",
        publicationId: "2026-08-25T12:00:00.000Z",
        state: "streaming",
        fallback: "local-webgpu",
        viewerUrl: "https://worker.example.test/watch/worker-session-1",
        mediaEvidence: {
          kind: "webrtc-outbound-rtp",
          observedAt: "2026-08-25T12:00:09.000Z",
          peerConnectionId: "peer-1",
          videoTrackId: "track-1",
          codec: "h264",
          hardwareEncoder: true,
          encoderImplementation: "NVIDIA NVENC",
          encoderEvidence: "runtime-stats",
          width: 1920,
          height: 1080,
          framesEncoded: 120,
          packetsSent: 480,
          bytesSent: 1_200_000
        }
      }
    }]
  };
}
