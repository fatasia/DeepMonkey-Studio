import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, ensureRows, instanceDialog, observeDiagnostics, saveScene, themeContext, uploadModel } from "./gateModelInstancesSupport.mjs";
import { URDF_GATE_NAME, URDF_GATE_SOURCE } from "./urdfGateFixture.mjs";
import { createRosbridgeGateFixture } from "./rosbridgeGateFixture.mjs";

const gate = await createIsolatedStudioGate("robot-connection");
const report = { createdAt: new Date().toISOString(), browser: gate.browser.version(), requireCooldown: Boolean(process.env.ROS_GATE_REQUIRE_COOLDOWN), bundleSha256: createHash("sha256").update(await readFile(new URL("../dist/index.html", import.meta.url))).digest("hex"), cases: [], boundaries: ["独立临时API与自制URDF；只连接127.0.0.1模拟rosbridge，不连接用户设备。", "浏览器实际WS握手/协议与3D像素变化；发布不等于设备接受/执行，无设备ACK。", "运行期间零工作区写；不把ROS端点或遥测写入作者场景。"] };
console.log(JSON.stringify({ output: gate.output }));
async function waitFor(page, predicate, label) { for (let i = 0; i < 150; i++) { if (predicate()) return; await page.waitForTimeout(40); } throw new Error(`Timed out: ${label}`); }
async function pixelDifference(before, after) {
  const first = await sharp(before).removeAlpha().raw().toBuffer({ resolveWithObject: true }), second = await sharp(after).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(first.info, second.info); let changed = 0;
  for (let index = 0; index < first.data.length; index += 3) if ([0, 1, 2].some(channel => Math.abs(first.data[index + channel] - second.data[index + channel]) > 20)) changed++;
  return changed / (first.info.width * first.info.height);
}
async function runCase(theme, width) {
  const entry = { theme, width, version: theme === "dark" ? "ros2" : "ros1", passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [], writes: [] }; report.cases.push(entry);
  const context = await themeContext(gate, theme, width), page = await context.newPage(), bridge = await createRosbridgeGateFixture(); page.setDefaultTimeout(25000);
  observeDiagnostics(page, entry); const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
  try {
    const project = await gate.json("POST", "/api/projects", { name: `ROS连接-${theme}-${width}` });
    const model = await uploadModel(gate, project.id, page, URDF_GATE_NAME, Buffer.from(URDF_GATE_SOURCE));
    const { appPath, scenePath } = await createScene(gate, page, project.id);
    const row = await ensureRows(page, model.id); await row.locator(".asset-main").click(); await row.getByRole("button", { name: "隐藏", exact: true }).waitFor();
    const dialog = await instanceDialog(page, row); await dialog.getByRole("button", { name: "新增副本", exact: true }).click(); await dialog.waitFor({ state: "detached" });
    const dualScene = await saveScene(page, appPath); const copy = dualScene.models.find(item => item.modelId !== model.id); assert.ok(copy);
    const copyRow = await ensureRows(page, copy.modelId); await copyRow.getByRole("button", { name: "隐藏", exact: true }).click(); await row.locator(".asset-main").click();
    const panel = page.locator(".robot-connection-panel"), canvas = page.locator(".viewport canvas"); await panel.waitFor();
    await page.getByRole("button", { name: "适应全部", exact: true }).click(); await page.waitForTimeout(1300);
    await saveScene(page, appPath); const before = await gate.json("GET", appPath);
    page.on("request", request => { if (request.method() === "PUT" && request.url().includes(appPath)) entry.writes.push(request.url()); });
    assert.equal(bridge.sessions.length, 0); assert.equal(await panel.locator("details").getAttribute("open"), null);
    await panel.getByLabel("rosbridge 地址").fill(bridge.url); await panel.getByLabel("ROS 版本").selectOption(entry.version);
    entry.presentation = await panel.evaluate(element => ({ width: element.getBoundingClientRect().width, fields: [...element.querySelectorAll('input:not([type="checkbox"]),select,button')].filter(node => node.getBoundingClientRect().height && !node.disabled).map(node => {
      const style = getComputedStyle(node); return { text: node.getAttribute("aria-label") || node.textContent, color: style.color, background: style.backgroundColor, height: node.getBoundingClientRect().height };
    }) }));
    await panel.scrollIntoViewIfNeeded(); await shot("disconnected"); const authorCanvas = await canvas.screenshot();
    await panel.getByRole("button", { name: "连接", exact: true }).click();
    await waitFor(page, () => bridge.sessions[0]?.topic, "real subscription"); let session = bridge.sessions[0];
    assert.equal(session.type, entry.version === "ros2" ? "sensor_msgs/msg/JointState" : "sensor_msgs/JointState");
    bridge.frame(session, 1); await panel.getByText("遥测有效", { exact: true }).waitFor(); await panel.getByText("匹配 4/4 个关节", { exact: true }).waitFor();
    await page.waitForTimeout(120); const telemetryCanvas = await canvas.screenshot(); entry.telemetryPixelRatio = await pixelDifference(authorCanvas, telemetryCanvas);
    assert.ok(entry.telemetryPixelRatio > .001, "Telemetry must move real rendered joints");
    for (const label of ["base_yaw (°)", "shoulder_pitch (°)", "elbow_pitch (°)", "gripper_open (m)"]) {
      const input = page.getByRole("spinbutton", { name: label, exact: true }); assert.equal(await input.inputValue(), "0"); assert.equal(await input.isDisabled(), true);
    }
    await shot("live");
    bridge.frame(session, 2, undefined, { name: ["base_yaw", "base_yaw"], position: [1, 2] }); await panel.getByRole("alert").filter({ hasText: "重复关节名" }).waitFor();
    bridge.frame(session, 3, undefined, { position: [1] }); await panel.getByRole("alert").filter({ hasText: "长度不一致" }).waitFor();
    bridge.frame(session, 4, undefined, { name: ["unmapped"], position: [1] }); await panel.getByRole("alert").filter({ hasText: "没有匹配" }).waitFor();
    bridge.frame(session, 5); await panel.getByRole("alert").waitFor({ state: "detached" });
    bridge.frame(session, 1); await panel.getByRole("alert").filter({ hasText: "旧帧" }).waitFor();
    for (let sec = 10; sec < 510; sec++) bridge.frame(session, sec); await panel.getByRole("alert").waitFor({ state: "detached" });
    assert.equal(bridge.messages.filter(message => message.op === "publish").length, 0);
    await panel.getByText("遥测过期", { exact: true }).waitFor(); await shot("stale");
    bridge.frame(session, 510); await panel.getByText("遥测有效", { exact: true }).waitFor();
    await panel.getByRole("button", { name: "发现主题", exact: true }).click(); await panel.getByLabel("切换状态主题").selectOption("/robot/joint_states");
    await waitFor(page, () => session.closed && bridge.sessions[1]?.topic === "/robot/joint_states", "topic switch tears down old socket"); session = bridge.sessions[1];
    bridge.frame(session, 1); await panel.getByText("遥测有效", { exact: true }).waitFor();
    await panel.getByRole("checkbox", { name: "跟随遥测", exact: true }).uncheck();
    assert.ok(await pixelDifference(authorCanvas, await canvas.screenshot()) < entry.telemetryPixelRatio * .2, "Leaving follow restores author pose");
    const targetJoint = page.getByRole("spinbutton", { name: "base_yaw (°)", exact: true }); assert.equal(await targetJoint.isDisabled(), false); await targetJoint.fill("20");
    bridge.frame(session, 2); await page.waitForTimeout(100); assert.equal(await targetJoint.inputValue(), "20");
    await panel.locator("summary").click(); assert.equal(await panel.getByRole("checkbox", { name: "启用本次姿态发送" }).isChecked(), false);
    await panel.getByRole("checkbox", { name: "启用本次姿态发送" }).check(); await panel.getByLabel("姿态控制主题").fill("/controller/joint_trajectory");
    await panel.getByLabel("姿态目标时长").fill("1.5"); bridge.frame(session, 3);
    await panel.getByRole("button", { name: "发送目标姿态", exact: true }).dblclick();
    await waitFor(page, () => bridge.messages.some(message => message.op === "publish"), "explicit trajectory");
    const commands = bridge.messages.filter(message => message.op === "publish"); assert.equal(commands.length, 1);
    const command = commands[0]; assert.equal(command.topic, "/controller/joint_trajectory");
    const sentPose = Object.fromEntries(command.msg.joint_names.map((name, index) => [name, command.msg.points[0].positions[index]]));
    assert.ok(Math.abs(sentPose.base_yaw - 20 * Math.PI / 180) < 1e-9); assert.equal(sentPose.shoulder_pitch, 0); assert.equal(sentPose.elbow_pitch, 0); assert.equal(sentPose.gripper_open, 0);
    assert.equal(command.msg.joint_names.length, 4); assert.deepEqual(command.msg.points[0].time_from_start, entry.version === "ros2" ? { sec: 1, nanosec: 500000000 } : { secs: 1, nsecs: 500000000 });
    await panel.getByText("已发送，未确认", { exact: true }).waitFor(); await shot("sent-unconfirmed");
    if (process.env.ROS_GATE_REQUIRE_COOLDOWN) assert.equal(await panel.getByRole("alert").count(), 0, "A blocked second click must not imply a network failure");
    bridge.send(session, { op: "status", level: "error", id: command.id }); await panel.getByText("rosbridge 返回控制错误；设备执行状态未知。", { exact: true }).first().waitFor();
    await targetJoint.fill("0"); await panel.getByRole("checkbox", { name: "跟随遥测", exact: true }).check(); bridge.frame(session, 4); await page.waitForTimeout(80);
    await panel.locator("summary").focus(); await page.keyboard.press("Escape"); assert.equal(await panel.locator("details").getAttribute("open"), null);
    await panel.getByRole("button", { name: "断开", exact: true }).click(); await waitFor(page, () => session.closed, "explicit disconnect");
    await page.waitForTimeout(100); entry.restoredPixelRatio = await pixelDifference(authorCanvas, await canvas.screenshot());
    assert.ok(entry.restoredPixelRatio < entry.telemetryPixelRatio * .2, "Disconnect must restore authored rendered pose");
    await panel.getByRole("button", { name: "连接", exact: true }).click(); await waitFor(page, () => bridge.sessions[2]?.topic, "reconnect"); session = bridge.sessions[2];
    bridge.frame(session, 1); await panel.getByText("遥测有效", { exact: true }).waitFor(); session.socket.close(1000);
    await panel.getByText("已断开", { exact: true }).waitFor();
    assert.ok(await pixelDifference(authorCanvas, await canvas.screenshot()) < entry.telemetryPixelRatio * .2, "Server close must restore authored pose");
    await panel.getByRole("button", { name: "连接", exact: true }).click(); await waitFor(page, () => bridge.sessions[3]?.topic, "fourth session"); session = bridge.sessions[3];
    bridge.frame(session, 1); await panel.getByText("遥测有效", { exact: true }).waitFor(); await copyRow.locator(".asset-main").click();
    await waitFor(page, () => session.closed, "model switch closes old session"); await panel.getByText("未连接", { exact: true }).waitFor();
    assert.equal(bridge.sessions.length, 4); await row.locator(".asset-main").click();
    await panel.getByLabel("rosbridge 地址").fill(bridge.url); await panel.getByLabel("ROS 版本").selectOption(entry.version);
    await panel.getByRole("button", { name: "连接", exact: true }).click(); await waitFor(page, () => bridge.sessions[4]?.topic, "fifth session"); session = bridge.sessions[4];
    bridge.frame(session, 1); await panel.getByText("遥测有效", { exact: true }).waitFor(); await page.goto(scenePath);
    await waitFor(page, () => session.closed, "page exit closes socket"); await canvas.waitFor();
    const reloaded = await ensureRows(page, model.id); await reloaded.locator(".asset-main").click(); await panel.waitFor();
    await panel.getByText("未连接", { exact: true }).waitFor(); await page.waitForTimeout(200);
    assert.equal(bridge.sessions.length, 5); assert.equal(bridge.messages.filter(message => message.op === "publish").length, 1);
    assert.deepEqual(await gate.json("GET", appPath), before); assert.deepEqual(entry.writes, []); assert.deepEqual(entry.errors, []);
    entry.sessions = bridge.sessions.length; entry.sessionsClosed = bridge.sessions.every(item => item.closed); assert.equal(entry.sessionsClosed, true);
    entry.protocol = bridge.messages; entry.passed = true; await shot("reloaded");
  } catch (error) { entry.failure = error.stack; entry.body = await page.locator("body").innerText(); await shot("failed"); throw error; }
  finally { await context.close(); await bridge.close(); console.log(JSON.stringify(entry)); }
}
try { for (const theme of ["dark", "light"]) for (const width of [1440, 980]) if (!process.env.ROS_GATE_CASE || process.env.ROS_GATE_CASE === `${theme}-${width}`) await runCase(theme, width); }
finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.length > 0 && report.cases.every(item => item.passed) }));
