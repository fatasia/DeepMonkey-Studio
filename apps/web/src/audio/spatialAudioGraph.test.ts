import { describe, expect, it, vi } from "vitest";
import { buildSpatialGraph, disposeSpatialGraph, positionSpatialGraph, type SpatialAudioGraphNodes } from "./spatialAudioGraph";
import { effectiveLinearVolume } from "./spatialAudioAttenuation";

/**
 * 泄漏证明(node 层):用忠实于 WebAudio API 形状的最小 stub 记录
 * create/connect/stop/disconnect 调用,断言 disposeSpatialGraph 的释放语义;
 * 真实节点上的声学行为由 offlineAudioAudit.ts 在 Chrome OfflineAudioContext 验证。
 */

interface FakeNode {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  buffer?: unknown;
  loop?: boolean;
  stop?: ReturnType<typeof vi.fn>;
  gain?: { value: number };
  panningModel?: string;
  distanceModel?: string;
  refDistance?: number;
  maxDistance?: number;
  rolloffFactor?: number;
  positionX?: { value: number };
  positionY?: { value: number };
  positionZ?: { value: number };
  setPosition?: (x: number, y: number, z: number) => void;
}

interface FakeContext {
  createdNodes: FakeNode[];
  createBufferSource: () => FakeNode;
  createGain: () => FakeNode;
  createPanner: () => FakeNode;
}

function createFakeContext(): FakeContext {
  const createdNodes: FakeNode[] = [];
  const makeNode = (extra: Omit<FakeNode, "connect" | "disconnect">) => {
    const node: FakeNode = { ...extra, connect: vi.fn(), disconnect: vi.fn() };
    createdNodes.push(node);
    return node;
  };
  return {
    createdNodes,
    createBufferSource: () => makeNode({ buffer: null, loop: false, stop: vi.fn() }),
    createGain: () => makeNode({ gain: { value: 0 } }),
    createPanner: () => makeNode({
      panningModel: "",
      distanceModel: "",
      refDistance: 0,
      maxDistance: 0,
      rolloffFactor: 0,
      positionX: { value: 0 },
      positionY: { value: 0 },
      positionZ: { value: 0 },
    }),
  };
}

function asGraphContext(fake: FakeContext): BaseAudioContext {
  return fake as unknown as BaseAudioContext;
}

function asGraphBuffer(): AudioBuffer {
  return { sampleRate: 44100 } as unknown as AudioBuffer;
}

const DESTINATION = {} as AudioNode;

describe("spatial audio graph build/dispose (T29)", () => {
  it("maps contract parameters onto the PannerNode and volume onto the gain", () => {
    const fake = createFakeContext();
    const graph = buildSpatialGraph(asGraphContext(fake), asGraphBuffer(), {
      volume: 4,
      muted: true,
      loop: true,
      refDistance: 2,
      maxDistance: 50,
      rolloffFactor: 1.5,
    }, DESTINATION);
    const [source, gain, panner] = fake.createdNodes;
    expect(source?.loop).toBe(true);
    expect(gain?.gain?.value).toBe(effectiveLinearVolume(4, true));
    expect(panner?.distanceModel).toBe("inverse");
    expect(panner?.refDistance).toBe(2);
    expect(panner?.maxDistance).toBe(50);
    expect(panner?.rolloffFactor).toBe(1.5);
    expect(panner?.panningModel).toBe("HRTF");
    expect(source?.connect).toHaveBeenCalledWith(gain);
    expect(gain?.connect).toHaveBeenCalledWith(panner);
    expect(panner?.connect).toHaveBeenCalledWith(DESTINATION);
    expect(graph.disposed).toBe(false);
  });

  it("honours an explicit equalpower panning model for offline assertions", () => {
    const fake = createFakeContext();
    buildSpatialGraph(asGraphContext(fake), asGraphBuffer(), {
      volume: 1, muted: false, loop: false, refDistance: 1, maxDistance: 10, rolloffFactor: 1,
      panningModel: "equalpower",
    }, DESTINATION);
    expect(fake.createdNodes[2]?.panningModel).toBe("equalpower");
  });

  it("positions the source via AudioParam when available", () => {
    const fake = createFakeContext();
    const graph = buildSpatialGraph(asGraphContext(fake), asGraphBuffer(), {
      volume: 1, muted: false, loop: false, refDistance: 1, maxDistance: 10, rolloffFactor: 1,
    }, DESTINATION);
    positionSpatialGraph(graph as unknown as SpatialAudioGraphNodes, 4, 5, 6);
    const panner = fake.createdNodes[2];
    expect(panner?.positionX?.value).toBe(4);
    expect(panner?.positionY?.value).toBe(5);
    expect(panner?.positionZ?.value).toBe(6);
  });

  it("falls back to setPosition when AudioParam positions are absent (Safari shape)", () => {
    const fake = createFakeContext();
    const graph = buildSpatialGraph(asGraphContext(fake), asGraphBuffer(), {
      volume: 1, muted: false, loop: false, refDistance: 1, maxDistance: 10, rolloffFactor: 1,
    }, DESTINATION);
    const panner = fake.createdNodes[2]!;
    delete panner.positionX;
    panner.setPosition = vi.fn();
    positionSpatialGraph(graph as unknown as SpatialAudioGraphNodes, 1, 2, 3);
    expect(panner.setPosition).toHaveBeenCalledWith(1, 2, 3);
  });

  it("dispose stops the source, disconnects every node and clears references", () => {
    const fake = createFakeContext();
    const graph = buildSpatialGraph(asGraphContext(fake), asGraphBuffer(), {
      volume: 1, muted: false, loop: false, refDistance: 1, maxDistance: 10, rolloffFactor: 1,
    }, DESTINATION);
    disposeSpatialGraph(graph);
    const [source, gain, panner] = fake.createdNodes;
    expect(source?.stop).toHaveBeenCalledTimes(1);
    expect(source?.disconnect).toHaveBeenCalledTimes(1);
    expect(gain?.disconnect).toHaveBeenCalledTimes(1);
    expect(panner?.disconnect).toHaveBeenCalledTimes(1);
    expect(graph.source).toBeNull();
    expect(graph.gain).toBeNull();
    expect(graph.panner).toBeNull();
    expect(graph.disposed).toBe(true);
  });

  it("is idempotent: repeated dispose performs no second release and tolerates stop() failures", () => {
    const fake = createFakeContext();
    const graph = buildSpatialGraph(asGraphContext(fake), asGraphBuffer(), {
      volume: 1, muted: false, loop: false, refDistance: 1, maxDistance: 10, rolloffFactor: 1,
    }, DESTINATION);
    const source = fake.createdNodes[0]!;
    source.stop?.mockImplementation(() => {
      throw new DOMException("not started", "InvalidStateError");
    });
    disposeSpatialGraph(graph);
    disposeSpatialGraph(graph);
    disposeSpatialGraph(graph);
    expect(source.disconnect).toHaveBeenCalledTimes(1);
  });

  it("1000 build/dispose cycles release every created node exactly once (leak proof: node layer)", () => {
    const fake = createFakeContext();
    const cycles = 1000;
    for (let index = 0; index < cycles; index += 1) {
      const graph = buildSpatialGraph(asGraphContext(fake), asGraphBuffer(), {
        volume: 1, muted: false, loop: true, refDistance: 1, maxDistance: 10, rolloffFactor: 1,
      }, DESTINATION);
      disposeSpatialGraph(graph);
    }
    expect(fake.createdNodes).toHaveLength(cycles * 3);
    for (const node of fake.createdNodes) {
      expect(node.disconnect).toHaveBeenCalledTimes(1);
      if (node.stop) expect(node.stop).toHaveBeenCalledTimes(1);
    }
  });
});
