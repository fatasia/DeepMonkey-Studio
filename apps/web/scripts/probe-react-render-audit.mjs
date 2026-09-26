import { mkdirSync, writeFileSync } from "node:fs";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// React↔3D 边界重渲染探针:注入 DevTools hook,按 commit 统计重渲染组件与耗时。
// 注意:应用为 StrictMode + React 19 dev 构建,函数组件每次 commit 双调用,
// renders 计数约为生产语义的 2 倍;commit 数不受影响。
// 数据落 test-output/react-audit/react-render-audit.json。

const webOrigin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:4100";
const login = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const { token } = await login.json();

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu", "--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
}, { token });
// 必须先于页面脚本安装 hook:React DOM 启动时会调用 hook.inject。
// 标记持久化到 sessionStorage,并发会话改源码触发 HMR 全刷新时场景窗口仍可归因。
await context.addInitScript(() => {
  const restore = () => { try { return JSON.parse(sessionStorage.getItem("probeMarks") ?? "[]"); } catch { return []; } };
  const marks = restore();
  const commits = [];
  const renderTotal = new Map();
  const branchTotal = new Map();
  let commitIndex = 0;
  let reloaded = sessionStorage.getItem("probeReloaded") === "1";
  if (marks.length > 0 || sessionStorage.getItem("probeStarted") === "1") reloaded = true;
  sessionStorage.setItem("probeStarted", "1");
  sessionStorage.setItem("probeReloaded", reloaded ? "1" : "0");
  // 归因标记:commit 发生在 rAF 回调内(→ requestRevision 的 rAF 合并路径)或紧邻 pointermove
  let rafDepth = 0;
  const origRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => origRAF((t) => { rafDepth += 1; try { cb(t); } finally { rafDepth -= 1; } });
  let lastPointerMoveT = -1e9;
  window.addEventListener("pointermove", () => { lastPointerMoveT = performance.now(); }, { capture: true, passive: true });
  const nameOf = (fiber) => {
    const type = fiber.type;
    if (typeof type === "string") return `host:${type}`;
    if (typeof type === "function") return type.displayName || type.name || "(anonymous fn)";
    if (type && typeof type === "object" && typeof type.displayName === "string") return type.displayName;
    return "(other)";
  };
  const walk = (fiber, branch, window0, byName, byBranch, mode, sink) => {
    const stack = [[fiber, branch]];
    while (stack.length > 0) {
      const [node, ancestor] = stack.pop();
      if (!node) continue;
      const name = nameOf(node);
      let rendered = false;
      if (mode === "flags") rendered = (node.flags & 1) === 1;
      else {
        const st = node.actualStartTime;
        rendered = typeof st === "number" && st >= window0;
        if (!rendered && (node.flags & 1) === 1) rendered = true;
      }
      const isFn = typeof node.type === "function";
      if (rendered && isFn) {
        const dur = node.actualDuration;
        const slot = byName.get(name) ?? { renders: 0, ms: 0 };
        slot.renders += 1;
        if (typeof dur === "number" && Number.isFinite(dur)) slot.ms += dur;
        byName.set(name, slot);
        const bslot = byBranch.get(ancestor) ?? { renders: 0, ms: 0 };
        bslot.renders += 1;
        if (typeof dur === "number" && Number.isFinite(dur)) bslot.ms += dur;
        byBranch.set(ancestor, bslot);
        sink.count += 1;
        if (typeof dur === "number" && Number.isFinite(dur)) sink.ms += dur;
        const childBranch = name;
        let child = node.child;
        while (child) { stack.push([child, childBranch]); child = child.sibling; }
      } else {
        let child = node.child;
        while (child) { stack.push([child, ancestor]); child = child.sibling; }
      }
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(internals) {
      const id = (this._nextId = (this._nextId ?? 0) + 1);
      this.renderers.set(id, { id, ...internals });
      return id;
    },
    onCommitFiberRoot(_id, root) {
      try {
        const t0 = performance.now();
        const byName = new Map();
        const byBranch = new Map();
        const sink = { count: 0, ms: 0 };
        walk(root.current, "(root)", t0 - 120, byName, byBranch, "flags", sink);
        let mode = "flags";
        if (sink.count === 0) {
          byName.clear(); byBranch.clear(); sink.count = 0; sink.ms = 0;
          walk(root.current, "(root)", t0 - 120, byName, byBranch, "time", sink);
          mode = "time";
        }
        const top = [...byName.entries()].sort((a, b) => b[1].renders - a[1].renders).slice(0, 6)
          .map(([name, v]) => ({ name, renders: v.renders, ms: Math.round(v.ms * 10) / 10 }));
        if (sink.count > 0) {
          commits.push({ i: commitIndex++, t: Math.round(t0), renders: sink.count, ms: Math.round(sink.ms * 10) / 10, mode,
            inRaf: rafDepth > 0, afterMove: (t0 - lastPointerMoveT) < 4, top });
        }
        for (const [name, v] of byName) {
          const slot = renderTotal.get(name) ?? { renders: 0, ms: 0 };
          slot.renders += v.renders; slot.ms += v.ms;
          renderTotal.set(name, slot);
        }
        for (const [name, v] of byBranch) {
          const slot = branchTotal.get(name) ?? { renders: 0, ms: 0 };
          slot.renders += v.renders; slot.ms += v.ms;
          branchTotal.set(name, slot);
        }
      } catch { /* 探针不得打断应用 */ }
    },
    onCommitFiberUnmount() {},
    _probe: { commits, renderTotal, branchTotal, reloaded: () => reloaded },
  };
  window.__probeMark = (label) => {
    marks.push({ label, t: Math.round(performance.now()) });
    try { sessionStorage.setItem("probeMarks", JSON.stringify(marks.slice(-200))); } catch {}
  };
  const lt = [];
  new PerformanceObserver((list) => { for (const e of list.getEntries()) lt.push({ d: Math.round(e.duration), t: Math.round(e.startTime) }); }).observe({ type: "longtask", buffered: true });
  window.__probeLongTasks = lt;
}, { token });

const page = await context.newPage();
await page.goto(`${webOrigin}/studio/fedab835-389b-43a5-99be-6820d0f3afde?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible", timeout: 60000 });
await page.waitForTimeout(2500);

const mark = (label) => page.evaluate((l) => { window.__probeMark(l); return Math.round(performance.now()); }, label);
const commitsBetween = (ta, tb) => page.evaluate(([a, b]) => {
  const commits = window.__REACT_DEVTOOLS_GLOBAL_HOOK__._probe.commits;
  return commits.filter((c) => c.t >= a && c.t <= b).reduce((acc, c) => acc + c.renders, 0);
}, [ta, tb]);
const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;

// S1 空闲基线
await mark("idle_start");
await page.waitForTimeout(2500);
await mark("idle_end");

// S2 悬停(无按键、信息面板关闭)
await mark("hover_start");
await page.mouse.move(x - 200, y - 100);
for (let i = 0; i < 60; i++) { await page.mouse.move(x - 200 + i * 7, y - 100 + (i % 10) * 12); await page.waitForTimeout(16); }
await mark("hover_end");

// S3 场景动画播放(导演台在"查看与分析"组,3 秒)
try {
  await mark("animation_open");
  await page.locator('.scene-tool-task-trigger[aria-label="查看与分析"]').click();
  await page.getByRole("menuitem", { name: "场景导演台", exact: true }).click();
  await page.waitForTimeout(500);
  await mark("animation_play_start");
  await page.locator(".timeline-play").first().click();
  await page.waitForTimeout(3000);
  await page.locator(".timeline-play").first().click();
  await mark("animation_play_end");
  // 关闭导演台,避免面板遮挡后续鼠标路径
  await page.getByRole("button", { name: "关闭时间线", exact: true }).click();
  await page.waitForTimeout(300);
} catch (reason) {
  await mark("animation_play_error");
  console.error("S3 skipped:", String(reason).slice(0, 200));
}

// S4 打开"场景信息"后悬停(setPointerInfo 直连路径)
try {
  await mark("info_on_start");
  await page.locator('.scene-tool-task-trigger[aria-label="查看与分析"]').click();
  await page.getByRole("menuitem", { name: "场景信息", exact: true }).click();
  await page.waitForTimeout(400);
  await mark("hover_info_start");
  for (let i = 0; i < 60; i++) { await page.mouse.move(x - 200 + i * 7, y - 100 + (i % 10) * 12); await page.waitForTimeout(16); }
  await mark("hover_info_end");
  // studio 的信息显示在右侧检查器(.scene-info-panel);用同一菜单开关关闭并断言
  await page.locator('.scene-tool-task-trigger[aria-label="查看与分析"]').click();
  await page.getByRole("menuitem", { name: "场景信息", exact: true }).click();
  await page.waitForTimeout(300);
  const infoOff = (await page.locator(".scene-info-panel").count()) === 0;
  await page.evaluate((v) => window.__probeMark(`info_off_assert:${v}`), infoOff);
  if (!infoOff) console.error("WARN: scene info panel still visible");
} catch (reason) {
  console.error("S4 skipped:", String(reason).slice(0, 200));
}

// S5 相机轨道拖拽(info 关闭)
await mark("orbit_start");
await page.mouse.move(x, y); await page.mouse.down();
for (let i = 0; i < 120; i++) {
  const phase = i / 119 * Math.PI * 4;
  await page.mouse.move(x + Math.sin(phase) * bounds.width * 0.18, y + Math.cos(phase * 0.5) * bounds.height * 0.08);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await mark("orbit_end");

// S6 滚轮缩放
await mark("wheel_start");
for (let i = 0; i < 15; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(60); }
await mark("wheel_end");

// S7 gizmo 拖拽(确定性:适应全部 → 场景目录选中首个模型 → 中心附近扫描 gizmo 轴命中点)
try {
  await page.getByRole("button", { name: "适应全部", exact: true }).click();
  await page.waitForTimeout(500);
  const row = page.locator("[data-scene-row-key]").first();
  await row.click();
  await page.waitForTimeout(600);
  await mark("gizmo_pick");
  // 围绕中心按半径扫描:每次试拖 3 步,commit 突增即 gizmo 命中
  let hit = null;
  const candidates = [[0, 0], [30, 0], [-30, 0], [0, 30], [0, -30], [60, 0], [-60, 0], [0, 60], [0, -60], [90, 0], [-90, 0]];
  for (const [dx, dy] of candidates) {
    const cx = x + dx, cy = y + dy;
    const sa = await mark(`scan_start:${dx},${dy}`);
    await page.mouse.move(cx, cy); await page.mouse.down();
    for (let i = 0; i < 3; i++) { await page.mouse.move(cx + (i + 1) * 6, cy); await page.waitForTimeout(16); }
    await page.mouse.up();
    const sb = await mark(`scan_end:${dx},${dy}`);
    const scanRenders = await commitsBetween(sa, sb);
    if (scanRenders >= 600) { hit = [dx, dy]; break; }
  }
  await page.evaluate((h) => window.__probeMark(`gizmo_hit:${h ? h.join(",") : "none"}`), hit);
  if (hit) {
    const cx = x + hit[0], cy = y + hit[1];
    await mark("gizmo_drag_start");
    await page.mouse.move(cx, cy); await page.mouse.down();
    for (let i = 0; i < 60; i++) { await page.mouse.move(cx + i * 3, cy + Math.sin(i / 8) * 4); await page.waitForTimeout(16); }
    await page.mouse.up();
    await mark("gizmo_drag_end");
    await page.waitForTimeout(200);
  }
} catch (reason) {
  await mark("gizmo_drag_end");
  console.error("S7 skipped:", String(reason).slice(0, 200));
}

const data = await page.evaluate(() => {
  const probe = window.__REACT_DEVTOOLS_GLOBAL_HOOK__._probe;
  const byName = [...probe.renderTotal.entries()]
    .map(([name, v]) => ({ name, renders: v.renders, ms: Math.round(v.ms * 10) / 10 }))
    .sort((a, b) => b.renders - a.renders);
  const byBranch = [...probe.branchTotal.entries()]
    .map(([name, v]) => ({ name, renders: v.renders, ms: Math.round(v.ms * 10) / 10 }))
    .sort((a, b) => b.renders - a.renders);
  return {
    reloaded: probe.reloaded(),
    commits: probe.commits,
    totalCommits: probe.commits.length,
    totalRenders: byName.reduce((acc, item) => acc + item.renders, 0),
    topComponents: byName.slice(0, 40),
    topBranches: byBranch.slice(0, 24),
    marks: (() => { try { return JSON.parse(sessionStorage.getItem("probeMarks") ?? "[]"); } catch { return []; } })(),
    longTasks: window.__probeLongTasks,
  };
});
mkdirSync("test-output/react-audit", { recursive: true });
writeFileSync("test-output/react-audit/react-render-audit.json", JSON.stringify(data, null, 1));

const label = (name) => { const hits = data.marks.filter((m) => m.label === name); return hits.length ? hits[hits.length - 1].t : undefined; };
const scenario = (name, a, b) => {
  const ta = label(a), tb = label(b);
  if (ta === undefined || tb === undefined) return { scenario: name, commits: 0, renders: 0, durationMs: 0, longTasks: 0, topComponents: "unmeasured(missing mark)", skipped: true };
  const cs = data.commits.filter((c) => c.t >= ta && c.t <= tb);
  const renders = cs.reduce((acc, c) => acc + c.renders, 0);
  const agg = new Map();
  for (const c of cs) for (const t of c.top) agg.set(t.name, (agg.get(t.name) ?? 0) + t.renders);
  const top = [...agg.entries()].sort((p, q) => q[1] - p[1]).slice(0, 8);
  const lt = data.longTasks.filter((t) => t.t >= ta - 50 && t.t <= tb + 150);
  return { scenario: name, commits: cs.length, renders, durationMs: tb - ta, longTasks: lt.length,
    topComponents: top.map(([n, r]) => `${n}:${r}`).join(", ") };
};
const infoOffMark = data.marks.find((m) => m.label.startsWith("info_off_assert"));
const summary = {
  reloaded: data.reloaded, totalCommits: data.totalCommits, totalRenders: data.totalRenders,
  infoOffAssert: infoOffMark ? infoOffMark.label : "missing",
  scenarios: [
    scenario("S1 idle", "idle_start", "idle_end"),
    scenario("S2 hover(info off)", "hover_start", "hover_end"),
    scenario("S3 animation play 3s", "animation_play_start", "animation_play_end"),
    scenario("S4a info open", "info_on_start", "hover_info_start"),
    scenario("S4b hover(info on)", "hover_info_start", "hover_info_end"),
    scenario("S5 orbit drag(info off)", "orbit_start", "orbit_end"),
    scenario("S6 wheel", "wheel_start", "wheel_end"),
    scenario("S7a gizmo pick", "gizmo_pick", "gizmo_drag_start"),
    scenario("S7b gizmo drag", "gizmo_drag_start", "gizmo_drag_end"),
  ],
  topBranches: data.topBranches,
};
console.log(JSON.stringify(summary, null, 1));
await browser.close();
