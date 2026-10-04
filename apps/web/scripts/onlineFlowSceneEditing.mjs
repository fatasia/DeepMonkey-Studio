import { resolve } from "node:path";

/** 覆盖高频移动和动画设置入口，避免能力存在但真实用户路径不可达。 */
export async function verifySceneMoveAndAnimation({ page, outputRoot }) {
  const dock = page.getByRole("toolbar", { name: "场景编辑工具" });
  const rotate = dock.getByRole("button", { name: /^旋转/ });
  const move = dock.getByRole("button", { name: /^移动/ });
  await rotate.click();
  if (await rotate.getAttribute("aria-pressed") !== "true") throw new Error("三维旋转模式没有形成明确反馈");
  await move.click();
  if (await move.getAttribute("aria-pressed") !== "true") throw new Error("三维移动模式没有形成明确反馈");

  // 动画入口已随信息架构调整并入"查看与分析"菜单(现名"场景导演台")。
  await dock.getByRole("button", { name: /查看与分析/ }).click();
  await page.getByRole("menuitem", { name: "场景导演台", exact: true }).click();
  const timeline = page.getByLabel("场景导演台");
  await timeline.waitFor({ state: "visible" });
  await timeline.getByRole("button", { name: "播放设置", exact: true }).click();
  const animationOptions = {
    autoplay: await timeline.getByText("进入预览时自动播放", { exact: true }).isVisible(),
    loopOrOnce: await timeline.getByText("循环播放（关闭即播放一次）", { exact: true }).isVisible(),
    speed: await timeline.getByText("播放速度", { exact: true }).isVisible(),
  };
  if (Object.values(animationOptions).some((value) => !value)) throw new Error(`动画常用设置缺失：${JSON.stringify(animationOptions)}`);
  await page.screenshot({ path: resolve(outputRoot, "03e-scene-animation-settings.png"), fullPage: true });
  await timeline.getByRole("button", { name: "关闭时间线", exact: true }).click();
  await timeline.waitFor({ state: "hidden" });
  return { transformMode: "translate", ...animationOptions };
}
