import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { collectReceiverDiagnostics } from "./receiverDiagnostics.js";
import { viewerHtml } from "./viewer.js";

const stats = [
  { id: "video", type: "inbound-rtp", kind: "video", codecId: "codec", frameWidth: 2560, frameHeight: 1440, framesDecoded: 120,
    framesPerSecond: 60, totalDecodeTime: 0.12, jitter: 0.003, packetsLost: 2, bytesReceived: 5000, decoderImplementation: "MediaFoundation", powerEfficientDecoder: true, remoteId: "private" },
  { id: "codec", type: "codec", mimeType: "video/H265" },
  { type: "candidate-pair", state: "succeeded", nominated: true, currentRoundTripTime: 0.01, availableIncomingBitrate: 5000000, localCandidateId: "local-private", remoteCandidateId: "remote-private" },
  { type: "local-candidate", address: "192.168.0.10", port: 12345, usernameFragment: "private-token" },
];
describe("cloud receiver diagnostics", () => {
  it("exports measured decode and network fields without candidates, addresses or credentials", () => {
    const evidence = collectReceiverDiagnostics(stats, { width: 2560, height: 1440, droppedVideoFrames: 3, privateField: 42 });
    expect(evidence.inbound[0]).toMatchObject({ codec: "video/H265", framesDecoded: 120, totalDecodeTime: 0.12, packetsLost: 2 });
    expect(evidence.network[0]).toMatchObject({ currentRoundTripTime: 0.01, availableIncomingBitrate: 5000000 });
    expect(JSON.stringify(evidence)).not.toMatch(/192\.168|private|Candidate|12345/);
    expect(collectReceiverDiagnostics([], {}).inbound).toEqual([]);
  });

  it("embedded collector works without module closures", () => {
    const embedded = runInNewContext(`(${collectReceiverDiagnostics.toString()})`);
    expect(embedded(stats, { width: 720 }).inbound[0].framesDecoded).toBe(120);
  });

  it("viewer export reports failure and retries to an actual JSON download", async () => {
    const handlers: Record<string, Record<string, () => Promise<void>>> = {};
    const elements = Object.fromEntries(["video", "status", "play", "diagnostics"].map(id => [id, {
      textContent: "", disabled: false, videoWidth: 1920, videoHeight: 1080, readyState: 4,
      addEventListener(event: string, handler: () => Promise<void>) { (handlers[id] ??= {})[event] = handler; },
    }]));
    let fail = true; let downloaded: Blob | undefined; let clicks = 0;
    class Peer { async getStats() { if (fail) throw new Error("closed"); return new Map(stats.map((value, index) => [index, value])); } }
    const script = viewerHtml("test", []).match(/<script type="module">([\s\S]*?)<\/script>/)![1]!;
    runInNewContext(script, {
      document: { querySelector: (selector: string) => elements[selector.slice(1)], createElement: () => ({ click() { clicks++; } }) },
      RTCPeerConnection: Peer, location: { hash: "", pathname: "/viewer/test" }, history: { replaceState() {} }, URLSearchParams,
      AbortSignal: { timeout() {} }, fetch: () => new Promise(() => {}), Blob,
      URL: { createObjectURL(blob: Blob) { downloaded = blob; return "blob:test"; }, revokeObjectURL() {} }, setTimeout: () => 1,
    });
    await handlers.diagnostics!.click!(); expect(elements.diagnostics!.textContent).toContain("失败"); expect(elements.diagnostics!.disabled).toBe(false);
    fail = false; await handlers.diagnostics!.click!();
    expect(elements.diagnostics!.textContent).toBe("诊断已导出"); expect(clicks).toBe(1);
    expect(JSON.parse(await downloaded!.text()).inbound[0].framesDecoded).toBe(120);
  });
});
