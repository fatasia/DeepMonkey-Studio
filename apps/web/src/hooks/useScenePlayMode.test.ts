import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenePhysicsState, SceneSnapshot } from "@bim-studio/contracts";
import * as React from "react";
import { useSceneHistoryState } from "./useSceneHistoryState";
import { SceneAuthoringHistory } from "../studio/sceneAuthoringHistory";
import { createScenePlayModeController, useScenePlayMode, formatPlayEntryNotice, formatPlayExitNotice, type ScenePlayModeHost } from "./useScenePlayMode";

vi.mock("react", () => {
  interface RefBox {
    current: unknown;
  }
  let boxes: RefBox[] = [];
  let refCursor = 0;
  return {
    // 渲染作用域内的 useRef 按调用序复用同一 ref 盒：__beginRender 后再次调用 hook
    // 即“同一实例的下一次渲染”（生产中 useRef 跨渲染持久的语义），选项按新渲染重绑。
    useRef: (current: unknown) => {
      const existing = boxes[refCursor];
      refCursor += 1;
      if (existing) return existing;
      const box = { current };
      boxes[refCursor - 1] = box;
      return box;
    },
    useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, vi.fn()],
    useEffect: () => undefined,
    __beginRender: () => {
      refCursor = 0;
    },
    __resetRefs: () => {
      boxes = [];
      refCursor = 0;
    },
  };
});
vi.mock("react-dom", () => ({ flushSync: (change: () => void) => change() }));

const reactMock = React as unknown as { __beginRender(): void; __resetRefs(): void };

// 防抖计时器走 window.*；vitest 默认 node 环境，桥接到全局计时器（与 fake timers 兼容）。
(globalThis as { window: unknown }).window = {
  setTimeout: (change: () => void, ms?: number) => setTimeout(change, ms),
  clearTimeout: (timer: number) => clearTimeout(timer),
};

beforeEach(() => {
  reactMock.__resetRefs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DEFAULT_PHYSICS: ScenePhysicsState = { enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } };

const DEFAULT_TRANSFORM = { position: { x: 0, y: 10, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };

function baseScene(name: string): SceneSnapshot {
  return {
    schemaVersion: 1,
    id: "scene-1",
    projectId: "project-1",
    name,
    camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [
      {
        modelId: "instance-a",
        name: "构件 A",
        visible: true,
        opacity: 1,
        transform: structuredClone(DEFAULT_TRANSFORM),
      },
    ] as SceneSnapshot["models"],
    primitives: [],
    measurements: [],
    weather: "rain",
    clipping: { enabled: false, axis: "z", offset: 0, inverted: false },
    physics: structuredClone(DEFAULT_PHYSICS),
    animation: {
      duration: 6,
      loop: true,
      playbackSpeed: 1,
      camera: [],
      models: [{ id: "frame-1", time: 0, modelId: "instance-a", transform: structuredClone(DEFAULT_TRANSFORM) }],
    },
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
}

function fakeEngine(physics: ScenePhysicsState) {
  const calls: string[] = [];
  let state = structuredClone(physics);
  let animationPlaying = false;
  const seeks: number[] = [];
  return {
    calls,
    seeks,
    get animationPlaying() {
      return animationPlaying;
    },
    getPhysicsState: () => structuredClone(state),
    setPhysicsState: (next: ScenePhysicsState) => {
      state = { ...structuredClone(next), playing: next.enabled && next.playing };
      calls.push(`physics(${state.enabled},${state.playing})`);
    },
    playSceneAnimation: () => {
      animationPlaying = true;
      calls.push("play");
    },
    pauseSceneAnimation: () => {
      animationPlaying = false;
      calls.push("pause");
    },
    seekSceneAnimation: (time: number) => {
      seeks.push(time);
      calls.push(`seek(${time})`);
    },
  };
}

type FakeEngine = ReturnType<typeof fakeEngine>;

/** 夹具：live 即画布事实状态；capture 每次深拷贝（与生产快照工厂同构）；applyScene 整体覆盖 live（与 applyScene 语义一致）。 */
function makeHost(engine: FakeEngine | undefined, live: SceneSnapshot, playhead = 0) {
  const calls = { flush: 0, apply: 0, errors: [] as unknown[] };
  let currentPlayhead = playhead;
  let applyError: unknown;
  return {
    calls,
    set playheadNext(value: number) {
      currentPlayhead = value;
    },
    failNextApplyWith(error: unknown) {
      applyError = error;
    },
    host: (): ScenePlayModeHost => ({
      engine,
      capture: () => structuredClone(live),
      flush: () => {
        calls.flush += 1;
      },
      applyScene: async (scene: SceneSnapshot) => {
        calls.apply += 1;
        engine?.calls.push("applyScene");
        if (applyError) {
          const error = applyError;
          applyError = undefined; // 仅下一次恢复失败
          throw error;
        }
        Object.assign(live, structuredClone(scene));
      },
      readAnimationPlayhead: () => currentPlayhead,
      reportError: (error: unknown) => {
        calls.errors.push(error);
      },
    }),
  };
}

describe("production Play hook host handoff", () => {
  it("reads the latest App host after the first render", async () => {
    const scene = baseScene("车间");
    const fixture = makeHost(fakeEngine(DEFAULT_PHYSICS), scene);
    reactMock.__beginRender();
    useScenePlayMode(() => ({ ...fixture.host(), engine: undefined }));
    reactMock.__beginRender();
    const play = useScenePlayMode(fixture.host);
    expect(play.enterPlay()).toEqual({ ok: true });
    expect(fixture.calls.flush).toBe(1);
    expect((await play.exitPlay()).ok).toBe(true);
  });

  it("rejects duplicate exit while the restore promise is still in flight", async () => {
    const scene = baseScene("车间");
    const fixture = makeHost(fakeEngine(DEFAULT_PHYSICS), scene);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const host = () => ({ ...fixture.host(), applyScene: async (_scene: SceneSnapshot) => { await pending; } });
    const play = createScenePlayModeController(host, () => undefined);
    expect(play.enterPlay().ok).toBe(true);
    const first = play.exitPlay();
    expect(await play.exitPlay()).toEqual({ ok: false, reason: "already-playing" });
    release();
    expect((await first).ok).toBe(true);
  });
});

describe("scene play mode lifecycle (T30)", () => {
  it("enterPlay flushes pending edits first, starts physics and animation drivers, and snapshots the scene isolated by deep copy", () => {
    vi.useFakeTimers();
    const live = baseScene("进入前");
    const engine = fakeEngine(DEFAULT_PHYSICS);
    const fixture = makeHost(engine, live, 1.25);
    const controller = createScenePlayModeController(fixture.host, () => undefined);

    expect(controller.enterPlay()).toEqual({ ok: true });
    expect(controller.active).toBe(true);
    expect(fixture.calls.flush).toBe(1); // 未提交编辑先收束
    expect(engine.calls).toEqual(["physics(true,true)", "play"]); // 双驱动启动
    expect(engine.animationPlaying).toBe(true);

    // 进入前快照与 live 深度隔离：播放中改写 live 不污染会话快照。
    live.name = "播放中被物理/动画改写";
    expect(live.name).not.toBe("进入前");
  });

  it("respects the authored physics enabled switch: disabled physics is not forced into playing", () => {
    vi.useFakeTimers();
    const live = baseScene("进入前");
    const engine = fakeEngine({ enabled: false, playing: false, gravity: { x: 0, y: -9.81, z: 0 } });
    const fixture = makeHost(engine, live);
    const controller = createScenePlayModeController(fixture.host, () => undefined);

    expect(controller.enterPlay()).toEqual({ ok: true });
    expect(engine.calls).toEqual(["play"]); // 物理关闭：只启动动画驱动，不改写作者开关
  });

  it("restores every authoring domain to the pre-enter snapshot on exit", async () => {
    vi.useFakeTimers();
    const before = baseScene("进入前");
    before.physics = { enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } };
    const live = structuredClone(before);
    const engine = fakeEngine(DEFAULT_PHYSICS);
    const fixture = makeHost(engine, live, 2.5);
    const controller = createScenePlayModeController(fixture.host, () => undefined);

    expect(controller.enterPlay()).toEqual({ ok: true });

    // 播放中：物理驱动位姿、动画改写名称、用户改外观/物理/动画/剖切/天气——全部是临时态。
    live.models[0]!.transform = { position: { x: 42, y: -3, z: 7 }, rotation: { x: 0.5, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    live.models[0]!.name = "被动画改写";
    live.name = "播放中改名";
    live.weather = "sunny";
    live.clipping = { enabled: true, axis: "y", offset: 5, inverted: true };
    live.physics = { enabled: true, playing: true, gravity: { x: 3, y: -1, z: 2 } };
    live.animation!.duration = 99;

    const result = await controller.exitPlay();
    expect(result).toEqual({ ok: true });
    expect(controller.active).toBe(false);
    // 逐域恢复矩阵：实例位姿/名称、场景名、天气、剖切、物理（enabled/gravity/playing）、动画时长全部回到进入前。
    expect(live).toEqual(before);
    // 驱动顺序：先停动画与物理驱动，再整体恢复。
    expect(engine.calls.indexOf("pause")).toBeLessThan(engine.calls.indexOf("applyScene"));
    expect(engine.calls.indexOf("physics(true,false)")).toBeLessThan(engine.calls.indexOf("applyScene"));
    // 播放头：进入前为 2.5s（applyScene 固定归零后按进入前事实回 seek），不是退出时的 2.5→0 残留。
    expect(engine.seeks).toEqual([2.5]);
    expect(engine.animationPlaying).toBe(false);
  });

  it("does not seek back when the pre-enter playhead was at zero", async () => {
    vi.useFakeTimers();
    const live = baseScene("进入前");
    const engine = fakeEngine(DEFAULT_PHYSICS);
    const fixture = makeHost(engine, live, 0);
    const controller = createScenePlayModeController(fixture.host, () => undefined);

    expect(controller.enterPlay()).toEqual({ ok: true });
    fixture.playheadNext = 4.2; // 播放中播放头前进
    await controller.exitPlay();
    expect(engine.seeks).toEqual([]); // 进入前为 0：applyScene 已归零，无需回 seek
  });

  it("rejects nested play and starts drivers exactly once", () => {
    vi.useFakeTimers();
    const live = baseScene("进入前");
    const engine = fakeEngine(DEFAULT_PHYSICS);
    const fixture = makeHost(engine, live);
    const controller = createScenePlayModeController(fixture.host, () => undefined);

    expect(controller.enterPlay()).toEqual({ ok: true });
    expect(controller.enterPlay()).toEqual({ ok: false, reason: "already-playing" });
    expect(engine.calls.filter((call) => call === "play")).toHaveLength(1);
    expect(fixture.calls.flush).toBe(1); // 嵌套进入不重复 flush
  });

  it("rejects entering without an engine or a ready scene, after still flushing pending edits", () => {
    vi.useFakeTimers();
    const live = baseScene("进入前");
    const noEngine = makeHost(undefined, live);
    const missingController = createScenePlayModeController(noEngine.host, () => undefined);
    expect(missingController.enterPlay()).toEqual({ ok: false, reason: "engine-missing" });
    expect(noEngine.calls.flush).toBe(1);

    const engine = fakeEngine(DEFAULT_PHYSICS);
    const notReady = makeHost(engine, live);
    const notReadyController = createScenePlayModeController(
      () => ({ ...notReady.host(), capture: () => undefined }), // 快照工厂拒绝（场景未就绪）
      () => undefined,
    );
    expect(notReadyController.enterPlay()).toEqual({ ok: false, reason: "scene-not-ready" });
    expect(engine.calls).toEqual([]); // 拒绝时不启动任何驱动
  });

  it("rejects exiting when not playing", async () => {
    vi.useFakeTimers();
    const live = baseScene("进入前");
    const fixture = makeHost(fakeEngine(DEFAULT_PHYSICS), live);
    const controller = createScenePlayModeController(fixture.host, () => undefined);
    expect(await controller.exitPlay()).toEqual({ ok: false, reason: "not-playing" });
    expect(fixture.calls.apply).toBe(0);
  });

  it("keeps play mode active and reports the failure when restore fails, so exit can be retried", async () => {
    vi.useFakeTimers();
    const before = baseScene("进入前");
    const live = structuredClone(before);
    const engine = fakeEngine(DEFAULT_PHYSICS);
    const fixture = makeHost(engine, live);
    const controller = createScenePlayModeController(fixture.host, () => undefined);
    expect(controller.enterPlay()).toEqual({ ok: true });

    live.name = "播放中的临时态";
    fixture.failNextApplyWith(new Error("模型资源缺失"));
    const failed = await controller.exitPlay();
    expect(failed).toEqual({ ok: false, reason: "restore-failed" });
    expect(controller.active).toBe(true); // 播放态保持：会话快照仍在，可重试
    expect(fixture.calls.errors).toHaveLength(1); // 失败如实上报
    expect(live.name).toBe("播放中的临时态"); // 未被半途改写

    const retried = await controller.exitPlay();
    expect(retried).toEqual({ ok: true });
    expect(controller.active).toBe(false);
    expect(live).toEqual(before);
  });

  it("reports and holds when the engine is lost mid-play", async () => {
    vi.useFakeTimers();
    const live = baseScene("进入前");
    const engine = fakeEngine(DEFAULT_PHYSICS);
    let currentEngine: FakeEngine | undefined = engine;
    const fixture = makeHost(engine, live);
    const controller = createScenePlayModeController(() => ({ ...fixture.host(), engine: currentEngine }), () => undefined);
    expect(controller.enterPlay()).toEqual({ ok: true });

    currentEngine = undefined; // 引擎在播放期间被替换/释放
    const result = await controller.exitPlay();
    expect(result).toEqual({ ok: false, reason: "engine-lost" });
    expect(fixture.calls.errors).toHaveLength(1);
    expect(controller.active).toBe(true);
  });
});

describe("play mode history isolation (T30 × T27)", () => {
  function historyHarness(playModeActive: boolean) {
    vi.useFakeTimers();
    reactMock.__resetRefs();
    const initial = baseScene("初始");
    const state = useSceneHistoryState({
      activeScene: structuredClone(initial),
      routeView: "studio",
      sceneBehaviorActive: false,
      animationPlaying: false,
      playModeActive,
    });
    const history = state.sceneHistoryRef.current;
    const live = structuredClone(initial);
    history.reset(structuredClone(initial));
    state.sceneSnapshotFactoryRef.current = () => structuredClone(live);
    let emissions = 0;
    history.subscribe(() => {
      emissions += 1;
    });
    return {
      state,
      history,
      live,
      get emissions() {
        return emissions;
      },
      rename: (name: string) => {
        live.name = name;
      },
      record: (label: string) => state.sceneHistoryRecordRef.current(label),
    };
  }

  it("absorbs schedule, flush and discrete commands during play: zero entries land", () => {
    const h = historyHarness(true);
    h.rename("播放中的临时改名");
    h.record("播放中的编辑");
    vi.advanceTimersByTime(300);
    h.state.flushSceneHistoryEdit();
    h.state.runSceneHistoryEdit(() => {
      h.live.models = [...h.live.models, { modelId: "transient" } as SceneSnapshot["models"][number]];
    });
    vi.advanceTimersByTime(300);
    expect(h.emissions).toBe(0); // 播放中零增长
    expect(h.history.getState()).toEqual({ canUndo: false, canRedo: false });
  });

  it("keeps the undo stack identical across enter → play → exit, and resumes recording after exit", () => {
    const build = (playModeActive: boolean) =>
      useSceneHistoryState({
        activeScene: structuredClone(baseScene("初始")),
        routeView: "studio",
        sceneBehaviorActive: false,
        animationPlaying: false,
        playModeActive,
      });

    vi.useFakeTimers();
    reactMock.__resetRefs();
    let state = build(false); // 进入前
    const history = state.sceneHistoryRef.current;
    const live = structuredClone(baseScene("初始"));
    history.reset(structuredClone(live));
    state.sceneSnapshotFactoryRef.current = () => structuredClone(live);
    let emissions = 0;
    history.subscribe(() => {
      emissions += 1;
    });

    // 进入前最后一条未提交编辑：进入 Play 的 flush 把它落栈。
    live.name = "进入前的编辑";
    state.sceneHistoryRecordRef.current("进入前的编辑");
    vi.advanceTimersByTime(220);
    const emissionsBeforePlay = emissions;
    const stackBeforePlay = history.getState();
    expect(stackBeforePlay).toMatchObject({ canUndo: true, undoLabel: "进入前的编辑" });

    reactMock.__beginRender(); // 同一 hook 实例的下一次渲染：Play 开启
    state = build(true);
    live.name = "播放中的临时改名";
    state.sceneHistoryRecordRef.current("播放中的编辑");
    vi.advanceTimersByTime(300);
    state.runSceneHistoryEdit(() => {
      live.models = [...live.models, { modelId: "transient" } as SceneSnapshot["models"][number]];
    });
    state.flushSceneHistoryEdit();
    state.beginSceneEditTransaction("播放中的事务").commit("播放中的事务提交");
    expect(emissions).toBe(emissionsBeforePlay); // 播放全程零增长（schedule/run/flush/事务提交全吸收）
    expect(history.getState()).toEqual(stackBeforePlay); // 栈状态与进入前一致

    reactMock.__beginRender(); // 退出 Play
    state = build(false);
    live.name = "退出后的正常编辑";
    state.sceneHistoryRecordRef.current("退出后的编辑");
    vi.advanceTimersByTime(220);
    expect(emissions).toBe(emissionsBeforePlay + 1); // 退出后记账恢复
    const undone = history.undo();
    expect(undone?.name).toBe("进入前的编辑"); // 撤销跳过播放期间的临时态，回到最后一条已提交事实
    expect(history.getState()).toEqual({ canUndo: true, canRedo: true, undoLabel: "进入前的编辑", redoLabel: "退出后的编辑" });
  });

  it("integrates with the play controller: enter flushes the pending edit into the stack, exit restores the pre-enter scene without touching the stack", async () => {
    vi.useFakeTimers();
    reactMock.__resetRefs();
    const state = useSceneHistoryState({
      activeScene: structuredClone(baseScene("初始")),
      routeView: "studio",
      sceneBehaviorActive: false,
      animationPlaying: false,
      playModeActive: false,
    });
    const history = state.sceneHistoryRef.current;
    const live = structuredClone(baseScene("初始"));
    history.reset(structuredClone(live));
    state.sceneSnapshotFactoryRef.current = () => structuredClone(live);
    let emissions = 0;
    history.subscribe(() => {
      emissions += 1;
    });

    const before = structuredClone(live);
    const engine = fakeEngine(DEFAULT_PHYSICS);
    const controller = createScenePlayModeController(
      () => ({
        engine,
        capture: () => state.sceneSnapshotFactoryRef.current?.(),
        flush: () => state.flushSceneHistoryEdit(),
        applyScene: async (scene) => {
          Object.assign(live, structuredClone(scene));
        },
        readAnimationPlayhead: () => 0,
        reportError: () => undefined,
      }),
      () => undefined,
    );

    // 未提交编辑在防抖窗口内：enterPlay 先 flush 落栈，再捕获进入前快照。
    live.name = "进入前的编辑";
    state.sceneHistoryRecordRef.current("进入前的编辑");
    expect(controller.enterPlay()).toEqual({ ok: true });
    expect(emissions).toBe(1);
    expect(history.getState()).toMatchObject({ canUndo: true, undoLabel: "进入前的编辑" });

    // 播放中：物理/动画驱动改写 live（临时态）；记账经 playModeActive 门禁吸收。
    live.models[0]!.transform = { position: { x: 9, y: 9, z: 9 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
    const gateState = useSceneHistoryState({
      activeScene: structuredClone(baseScene("初始")),
      routeView: "studio",
      sceneBehaviorActive: false,
      animationPlaying: false,
      playModeActive: true,
    });
    gateState.flushSceneHistoryEdit("播放中的编辑");
    const emissionsInPlay = emissions;

    // 退出：整体恢复到进入前快照；栈条目数不变（播放零条目）。
    expect(await controller.exitPlay()).toEqual({ ok: true });
    expect(live.models[0]!.transform).toEqual(before.models[0]!.transform);
    expect(emissions).toBe(emissionsInPlay);
    expect(history.getState()).toMatchObject({ canUndo: true, undoLabel: "进入前的编辑" });
  });

  it("counts absorbed schedule and discrete edits during play (S2b discard reporting), without changing any bookkeeping verdict", () => {
    const h = historyHarness(true);
    expect(h.state.playAbsorbedEditsRef.current).toBe(0);
    // 防抖散记 + 离散命令各被门禁吸收一次：计数如实累加，撤销栈零增长。
    h.record("播放中的散记");
    h.state.runSceneHistoryEdit(() => {
      h.live.name = "播放中的临时名";
    });
    vi.advanceTimersByTime(300);
    expect(h.state.playAbsorbedEditsRef.current).toBe(2);
    expect(h.emissions).toBe(0);
    expect(h.history.getState()).toEqual({ canUndo: false, canRedo: false });
    // App 在进入播放时清零：新会话从 0 重新计数（上一会话的数字由退出汇报消费）。
    h.state.playAbsorbedEditsRef.current = 0;
    h.record("第二次播放中的散记");
    expect(h.state.playAbsorbedEditsRef.current).toBe(1);
  });

  it("does not count authoring-domain bookkeeping outside play (counter stays at zero)", () => {
    const h = historyHarness(false);
    h.rename("作者域改名");
    h.record("作者域编辑");
    vi.advanceTimersByTime(300);
    h.state.runSceneHistoryEdit(() => {
      h.live.name = "作者域离散编辑";
    });
    expect(h.state.playAbsorbedEditsRef.current).toBe(0);
    expect(h.emissions).toBeGreaterThan(0);
  });
});

describe("play draft & discard notices (S2b)", () => {
  it("entry notice states the pending-draft exclusion only when a draft is actually pending", () => {
    expect(formatPlayEntryNotice(false)).toBe("已进入播放模式；修改仅在本次播放期间生效");
    expect(formatPlayEntryNotice(true)).toBe(
      "已进入播放模式；修改仅在本次播放期间生效；未保存的脚本草稿未参与本次播放，按已保存版本运行",
    );
  });

  it("exit notice reports the discarded transient edit count only when it is positive", () => {
    expect(formatPlayExitNotice(0)).toBe("已退出播放模式，场景恢复为进入前状态");
    expect(formatPlayExitNotice(7)).toBe("已退出播放模式；播放期间的 7 项临时状态变更已丢弃，场景已恢复为进入前状态");
  });
});

/**
 * P1-2（2026-10-06 对抗测试第二轮）复现与防线：清撤销栈风暴 → 立即播放。
 *
 * 复现序列（报告 §4.1）：快速放置 5 球体 → 连续撤销清栈（100ms 间隔）→ 点击播放 → 整页
 * STUDIO_RENDER_FAILED。竞态窗口 = 撤销恢复（applyScene 整体恢复 + acceptRestoredScene）
 * 在途时画布是中间态，旧代码的播放入口不设防：进入前快照拍到半程事实，恢复完成路径与
 * 播放驱动交错。修复 = Play 状态机入口新增 isHistorySettled 守卫（明确拒绝）+ 进入前
 * 快照克隆 fail-safe。本块在 hook 层复刻"放置在途+清栈+播放"序列并断言新契约。
 */
describe("clear-stack storm → play (P1-2 adversarial repro)", () => {
  /** 复刻 useSceneHistoryActions.undoSceneEdit/applySceneHistorySnapshot 的在途恢复语义（可受控挂起）。 */
  function stormFixture() {
    vi.useFakeTimers();
    const history = new SceneAuthoringHistory();
    let live = baseScene("真实模型与引擎演示");
    live = structuredClone(live);
    history.reset(structuredClone(live));
    const applyingRef = { current: false };
    let releaseApply: (() => void) | undefined;
    let holdApply = false;
    let debounceTimer: number | undefined;

    const placeSphere = (index: number) => {
      // 画布事实立即变更（引擎同步放置），防抖窗口后才构成一条撤销条目（onPrimitivePlaced 同构）；
      // 连续放置合并为一个防抖窗口（scheduleSceneHistoryEdit 先清前窗）。
      live = { ...live, primitives: [...live.primitives, { modelId: `sphere-${index}`, name: `球体 ${index}`, kind: "sphere", color: "#4d9fff" } as SceneSnapshot["primitives"][number]] };
      if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = undefined;
        history.record(structuredClone(live), "放置基础元素");
      }, 220);
    };

    const undoRestore = async (): Promise<"restored" | "empty" | "refused"> => {
      if (applyingRef.current) return "refused"; // 在途恢复未 settle：撤销整体拒绝
      const snapshot = history.undo();
      if (!snapshot) return "empty";
      applyingRef.current = true;
      const expectedRevision = history.revision;
      try {
        if (holdApply) await new Promise<void>((resolve) => { releaseApply = resolve; });
        live = structuredClone(snapshot); // 画布事实整体回到快照
        history.acceptRestoredScene(structuredClone(live), expectedRevision);
      } finally {
        applyingRef.current = false;
      }
      return "restored";
    };

    return {
      history,
      applyingRef,
      placeSphere,
      undoRestore,
      get live() {
        return live;
      },
      set live(scene: SceneSnapshot) {
        live = scene;
      },
      holdNextRestore() {
        holdApply = true;
      },
      releaseRestore() {
        releaseApply?.();
      },
    };
  }

  it("refuses Play while a clear-stack restore is still in flight, then admits it once settled", async () => {
    const storm = stormFixture();
    const engine = fakeEngine(DEFAULT_PHYSICS);
    const controller = createScenePlayModeController(
      () => ({
        engine,
        capture: () => structuredClone(storm.live),
        flush: () => undefined,
        applyScene: async (scene) => {
          storm.live = structuredClone(scene);
        },
        readAnimationPlayhead: () => 0,
        reportError: () => undefined,
        // 生产接线：App.tsx 以 !sceneHistoryApplyingRef.current 提供。
        isHistorySettled: () => !storm.applyingRef.current,
      }),
      () => undefined,
    );

    // 快速放置 5 球体：防抖窗口收束为撤销栈条目（与生产 scheduleSceneHistoryEdit 同窗口）。
    for (let index = 0; index < 5; index += 1) storm.placeSphere(index);
    await vi.advanceTimersByTimeAsync(220); // fake timers：先 flush 微任务再推进（防抖落栈）
    expect(storm.history.getState()).toMatchObject({ canUndo: true, undoLabel: "放置基础元素" });

    // 连续撤销清栈：第一笔恢复挂在途（模型重载异步窗口），后续点击整体拒绝。
    storm.holdNextRestore();
    const first = storm.undoRestore();
    const stormResults = ["refused", "refused", "refused", "refused", "refused", "refused", "refused", "refused", "refused"];
    expect(await Promise.all(stormResults.map(() => storm.undoRestore()))).toEqual(stormResults);
    expect(storm.applyingRef.current).toBe(true);

    // 竞态窗口：恢复在途 + 立即播放 → 旧代码无守卫（崩溃窗口），新契约必须明确拒绝。
    expect(controller.enterPlay()).toEqual({ ok: false, reason: "history-restore-in-flight" });
    expect(engine.calls).toEqual([]); // 驱动一个都没启动：拒绝绝不产生半启动会话
    expect(controller.active).toBe(false);

    // 恢复 settle 后同一入口放行：进入前快照 = 恢复完成的画布事实（零球体）。
    storm.releaseRestore();
    expect(await first).toBe("restored");
    expect(storm.applyingRef.current).toBe(false);
    expect(storm.live.primitives).toHaveLength(0);
    expect(storm.history.getState()).toEqual({ canUndo: false, canRedo: true, redoLabel: "放置基础元素" });

    expect(controller.enterPlay()).toEqual({ ok: true });
    expect(engine.calls).toEqual(["physics(true,true)", "play"]);
    expect(controller.active).toBe(true);
    expect(await controller.exitPlay()).toEqual({ ok: true });
  });

  it("treats an uncloneable entry snapshot as scene-not-ready instead of crashing", () => {
    const engine = fakeEngine(DEFAULT_PHYSICS);
    const controller = createScenePlayModeController(
      () => ({
        engine,
        capture: () => ({ ...baseScene("含运行时对象的中间态"), thumbnail: () => "opaque" }) as unknown as SceneSnapshot,
        flush: () => undefined,
        applyScene: async () => undefined,
        readAnimationPlayhead: () => 0,
        reportError: () => undefined,
      }),
      () => undefined,
    );
    // structuredClone 对函数抛 DataCloneError：进入前快照不可深拷贝 = 中间态，按未就绪拒绝。
    expect(controller.enterPlay()).toEqual({ ok: false, reason: "scene-not-ready" });
    expect(engine.calls).toEqual([]);
    expect(controller.active).toBe(false);
  });
});
