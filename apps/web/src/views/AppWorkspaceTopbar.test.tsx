import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewBindings } from "./appViewBindings";
import type { SceneSaveCarry } from "../controllers/scenePersistenceController";
import { AppWorkspaceTopbar } from "./AppWorkspaceTopbar";

const actions = vi.hoisted(() => ({ leave: undefined as (() => void) | undefined }));
vi.mock("../components/WorkspaceModeSwitch", () => ({ WorkspaceModeSwitch: (props: { onSelect2D: () => void }) => { actions.leave = props.onSelect2D; return null; } }));
vi.mock("../components/SceneWorkspaceMoreMenu", () => ({ SceneWorkspaceMoreMenu: () => null }));

const DEFAULT_CARRY: SceneSaveCarry = { scene: { id: "scene" } as SceneSaveCarry["scene"], thumbnail: "data:image/png;base64,carry" };

/** carry=null = 预捕获不可用（引擎未就绪/已释放），走"保存成功才离开"的回退契约。 */
function setup(carry: SceneSaveCarry | null = DEFAULT_CARRY) {
  const saveScene = vi.fn().mockResolvedValue({ id: "scene" });
  const captureSceneSaveCarry = vi.fn(() => carry ?? undefined);
  const saveActiveApplication = vi.fn().mockResolvedValue({ metadata: { id: "application" } });
  const returnFromSceneEditor = vi.fn(), commitSceneName = vi.fn().mockResolvedValue(true);
  const showError = vi.fn(), setError = vi.fn();
  const bindings = {
    state: { route: { view: "studio", applicationId: "application", sceneId: "scene" }, locale: "zh-CN", sceneName: "车间",
      activeApplication: { metadata: { id: "application" } }, activeScene: { id: "scene", name: "车间" },
      branding: {}, projects: [], setSceneBehaviorOpen: vi.fn(), pendingBehaviorDraftRef: { current: undefined }, showError, setError },
    scenePersistence: { saveScene, commitSceneName, captureSceneSaveCarry }, applicationRuntime: { saveActiveApplication, returnFromSceneEditor, upsertBehaviorScript: vi.fn() },
    actions: {}, sceneHistory: {},
  } as unknown as AppViewBindings;
  const render = () => renderToStaticMarkup(<AppWorkspaceTopbar bindings={bindings} />);
  render();
  return { bindings, saveScene, captureSceneSaveCarry, carry, saveActiveApplication, returnFromSceneEditor, commitSceneName, showError, setError, render, leave: () => actions.leave!() };
}

describe("Play mode toolbar state", () => {
  it("shows the Play action and marks authoring controls as unavailable while playing", () => {
    const fixture = setup();
    fixture.bindings.playMode = { active: false, enter: vi.fn(), exit: vi.fn() };
    const idle = fixture.render();
    expect(idle).toContain('aria-label="进入播放模式"');
    fixture.bindings.playMode.active = true;
    const running = fixture.render();
    expect(running).toContain('aria-label="退出播放模式并恢复场景"');
    expect(running).toContain('aria-label="自动保存已暂停"');
    expect(running).toContain('aria-label="播放中不可撤销"');
    expect(running).toContain('aria-label="播放中不可重做"');
    expect(running).toContain('先退出播放模式，再保存');
  });
});

describe("Publish-app zero-config semantics (P2-7)", () => {
  it("states the publication defaults (browser rendering, authored canvas, no native package) on the one-click action", () => {
    const html = setup().render();
    expect(html).toContain("零配置一键发布");
    expect(html).toContain("浏览器渲染");
    expect(html).toContain("画布与分辨率沿用各页面设置");
    expect(html).toContain("不生成本地安装包");
    // 指路离线包的正确入口,而不是让作者在发布动作上寻找打包配置。
    expect(html).toContain("离线运行包请用二维看板工具栏的「离线包」");
    // 完整构建配置属产品决策,本修复只做说明不引入配置 UI。
    expect(html).not.toContain("构建配置");
  });
});

describe("3D workspace exit save contract (P2-5 carry-first)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("pre-captures the viewport fact, returns to 2D immediately, then persists in background", async () => {
    const fixture = setup();
    // 后台保存永不结算：导航不允许等它——这正是 P2-5 要消除的十几秒阻塞。
    fixture.saveScene.mockReturnValue(new Promise(() => undefined));
    fixture.leave();
    await vi.runAllTimersAsync();
    expect(fixture.captureSceneSaveCarry).toHaveBeenCalledOnce();
    expect(fixture.returnFromSceneEditor).toHaveBeenCalledOnce();
    expect(fixture.returnFromSceneEditor).toHaveBeenCalledWith("dashboard");
    expect(fixture.saveScene).toHaveBeenCalledOnce();
    expect(fixture.saveScene).toHaveBeenCalledWith(false, fixture.carry);
  });

  it("keeps exit single-flight across repeated clicks", async () => {
    const fixture = setup();
    fixture.leave(); fixture.leave(); fixture.leave();
    await vi.runAllTimersAsync();
    expect(fixture.returnFromSceneEditor).toHaveBeenCalledOnce();
    expect(fixture.saveScene).toHaveBeenCalledOnce();
  });

  it("surfaces a background save rejection without blocking or re-blocking navigation", async () => {
    const fixture = setup();
    const failure = new Error("network down");
    fixture.saveScene.mockRejectedValueOnce(failure);
    fixture.leave();
    await vi.runAllTimersAsync();
    expect(fixture.returnFromSceneEditor).toHaveBeenCalledOnce();
    expect(fixture.showError).toHaveBeenCalledWith(failure);
  });

  it("falls back to save-before-leave when no carry can be captured (engine not ready)", async () => {
    const fixture = setup(null);
    fixture.leave();
    // 保存未结算前不得导航（旧契约在预捕获不可用时保持）。
    expect(fixture.returnFromSceneEditor).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(fixture.saveScene).toHaveBeenCalledOnce();
    expect(fixture.saveScene).toHaveBeenCalledWith();
    expect(fixture.returnFromSceneEditor).toHaveBeenCalledOnce();
  });

  it("keeps the editor on fallback save failure and allows an explicit retry", async () => {
    const fixture = setup(null);
    fixture.saveScene.mockResolvedValueOnce(undefined);
    fixture.leave(); await vi.runAllTimersAsync();
    expect(fixture.returnFromSceneEditor).not.toHaveBeenCalled();
    fixture.leave(); await vi.runAllTimersAsync();
    expect(fixture.saveScene).toHaveBeenCalledTimes(2);
    expect(fixture.returnFromSceneEditor).toHaveBeenCalledOnce();
  });

  it("does not navigate after a delayed fallback save if the user already left this route", async () => {
    const fixture = setup(null);
    let complete!: (result: { id: string }) => void;
    fixture.saveScene.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    fixture.leave(); await vi.advanceTimersByTimeAsync(0);
    fixture.bindings.state.route = { view: "manager" };
    complete({ id: "scene" }); await vi.runAllTimersAsync();
    expect(fixture.returnFromSceneEditor).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected fallback save rejection and unlocks navigation retry", async () => {
    const fixture = setup(null);
    const error = new Error("fixture failure");
    fixture.saveScene.mockRejectedValueOnce(error);
    fixture.leave(); await vi.runAllTimersAsync();
    expect(fixture.showError).toHaveBeenCalledWith(error);
    expect(fixture.returnFromSceneEditor).not.toHaveBeenCalled();
    fixture.leave(); await vi.runAllTimersAsync();
    expect(fixture.returnFromSceneEditor).toHaveBeenCalledOnce();
  });

  it("does not save or leave an empty scene name", async () => {
    const fixture = setup();
    fixture.bindings.state.sceneName = "  ";
    fixture.leave(); await vi.runAllTimersAsync();
    expect(fixture.commitSceneName).toHaveBeenCalledOnce();
    expect(fixture.saveScene).not.toHaveBeenCalled();
    expect(fixture.returnFromSceneEditor).not.toHaveBeenCalled();
  });
});
