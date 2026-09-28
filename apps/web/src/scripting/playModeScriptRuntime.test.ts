import { describe, expect, it, vi } from "vitest";
import { createPlayModeScriptRuntimeBridge, type ScriptRuntimeSession } from "./playModeScriptRuntime";

/** 假会话:记录 start/stop 次数与顺序。 */
function fakeSession(): ScriptRuntimeSession & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    start() {
      events.push("start");
    },
    stop() {
      events.push("stop");
    },
  };
}

describe("createPlayModeScriptRuntimeBridge(与 T30 useScenePlayMode 结构兼容,零文件耦合)", () => {
  it("active false→true 创建并 start 新会话;true→false stop 并丢弃", () => {
    let active = false;
    const sessions: string[] = [];
    const bridge = createPlayModeScriptRuntimeBridge({
      isActive: () => active,
      createSession: () => {
        const session = fakeSession();
        sessions.push("created");
        return session;
      },
    });
    expect(bridge.running).toBe(false);
    active = true;
    bridge.sync();
    expect(bridge.running).toBe(true);
    expect(sessions).toStrictEqual(["created"]);
    expect(bridge.session?.events).toStrictEqual(["start"]);

    active = false;
    bridge.sync();
    expect(bridge.running).toBe(false);
    expect(bridge.session).toBeUndefined();
  });

  it("重复 sync 幂等:不重复 start,也不重复 stop", () => {
    let active = false;
    const session = fakeSession();
    const bridge = createPlayModeScriptRuntimeBridge({ isActive: () => active, createSession: () => session });
    active = true;
    bridge.sync();
    bridge.sync();
    bridge.sync();
    expect(session.events).toStrictEqual(["start"]);
    active = false;
    bridge.sync();
    bridge.sync();
    // 退出后 session 已丢弃(bridge.session 为空),停止事实在会话对象上可查。
    expect(bridge.session).toBeUndefined();
    expect(session.events).toStrictEqual(["start", "stop"]);
  });

  it("每次进入 Play 都是新会话实例(会话隔离,与 T30 快照隔离口径一致)", () => {
    let active = false;
    const created: ReturnType<typeof fakeSession>[] = [];
    const bridge = createPlayModeScriptRuntimeBridge({
      isActive: () => active,
      createSession: () => {
        const session = fakeSession();
        created.push(session);
        return session;
      },
    });
    active = true;
    bridge.sync();
    active = false;
    bridge.sync();
    active = true;
    bridge.sync();
    expect(created).toHaveLength(2);
    expect(created[0]).not.toBe(created[1]);
    expect(created[0]?.events).toStrictEqual(["start", "stop"]);
    expect(created[1]?.events).toStrictEqual(["start"]);
  });

  it("createSession 抛错如实传播:进入失败、保持无会话", () => {
    let active = false;
    let attempts = 0;
    const bridge = createPlayModeScriptRuntimeBridge({
      isActive: () => active,
      createSession: () => {
        attempts += 1;
        throw new Error("运行时构建失败");
      },
    });
    active = true;
    expect(() => bridge.sync()).toThrow("运行时构建失败");
    expect(bridge.running).toBe(false);
    expect(attempts).toBe(1);
  });

  it("dispose:停止当前会话、退订信号、后续 sync 不再起会话", () => {
    let active = true;
    const session = fakeSession();
    const unsubscribe = vi.fn();
    const bridge = createPlayModeScriptRuntimeBridge({
      isActive: () => active,
      createSession: () => session,
      subscribe: () => unsubscribe,
    });
    // 订阅建立后立即对齐一次当前信号态(active=true)→ 已 start。
    expect(bridge.running).toBe(true);
    bridge.dispose();
    expect(session.events).toStrictEqual(["start", "stop"]);
    expect(unsubscribe).toHaveBeenCalled();
    active = true;
    bridge.sync();
    expect(bridge.running).toBe(false);
    expect(session.events).toStrictEqual(["start", "stop"]);
  });

  it("订阅驱动的信号变化自动 sync(Play 进入/退出各触发一次)", () => {
    let active = false;
    let notify: (() => void) | undefined;
    const bridge = createPlayModeScriptRuntimeBridge({
      isActive: () => active,
      createSession: fakeSession,
      subscribe: (cb) => {
        notify = cb;
        return () => {
          notify = undefined;
        };
      },
    });
    expect(notify).toBeTypeOf("function");
    active = true;
    notify?.();
    expect(bridge.running).toBe(true);
    active = false;
    notify?.();
    expect(bridge.running).toBe(false);
  });
});
