/** 为在线产品门禁创建确定性的工业数据源，不依赖外部数据库或网络。 */
export async function seedAskDataDataset({ page, apiOrigin, projectId, report }) {
  const token = await page.evaluate(() => localStorage.getItem("bim-studio-auth-token") ?? sessionStorage.getItem("bim-studio-auth-token"));
  if (!token) throw new Error("受控问数门禁缺少登录令牌");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const connection = await postJson(`${apiOrigin}/api/projects/${encodeURIComponent(projectId)}/data-connections`, headers, {
    name: "在线验收模拟遥测",
    type: "simulation",
    enabled: true,
    config: { url: "sim://telemetry?rows=30&seed=2026&interval=5" },
  }, 201);
  const dataset = await postJson(`${apiOrigin}/api/projects/${encodeURIComponent(projectId)}/datasets`, headers, {
    name: "设备遥测验收数据",
    connectionId: connection.id,
    refreshSeconds: 5,
    fields: [
      { key: "recorded_at", label: "采集时间", type: "datetime" },
      { key: "device_id", label: "设备", type: "string" },
      { key: "temperature", label: "温度", type: "number", unit: "°C" },
      { key: "pressure", label: "压力", type: "number", unit: "kPa" },
      { key: "vibration", label: "振动", type: "number", unit: "mm/s" },
      { key: "running", label: "运行", type: "boolean" },
    ],
  }, 201);
  const previewResponse = await fetch(`${apiOrigin}/api/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(dataset.id)}/preview`, { headers });
  if (!previewResponse.ok) throw new Error(`受控问数数据预览失败（HTTP ${previewResponse.status}）`);
  const preview = await previewResponse.json();
  if (preview.rows?.length !== 30 || !preview.fields?.some((field) => field.key === "temperature" && field.type === "number")) {
    throw new Error(`受控问数数据合同不完整：${JSON.stringify({ rows: preview.rows?.length, fields: preview.fields })}`);
  }
  report.steps.push({ id: "seed-ask-data-dataset", detail: { connectionId: connection.id, datasetId: dataset.id, rows: preview.rows.length } });
  return dataset;
}

/** 在真实 AI 面板中执行受控问数，结果必须来自 capability 读链并携带证据指纹。 */
export async function verifyAskDataBrowser({ page, assistantPanel, dataset, report, screenshotPath }) {
  await assistantPanel.getByRole("button", { name: "问数据", exact: true }).click();
  const quickQuery = assistantPanel.locator(".ask-data-quick");
  await quickQuery.waitFor({ state: "visible" });
  await quickQuery.getByLabel("数据集").selectOption(dataset.id);
  await quickQuery.getByLabel("指标").selectOption("temperature");
  await quickQuery.getByLabel("统计").selectOption("avg");
  await quickQuery.getByLabel("分组（可选）").selectOption("device_id");
  await quickQuery.getByRole("button", { name: "直接统计", exact: true }).click();
  const result = quickQuery.locator(".ask-data-result");
  await result.waitFor({ state: "visible", timeout: 30_000 });
  const audit = await result.evaluate((element) => ({
    rowCount: element.querySelectorAll("tbody tr").length,
    columnCount: element.querySelectorAll("thead th").length,
    evidenceFingerprint: element.querySelector("code")?.getAttribute("title") ?? "",
    summary: element.querySelector("small")?.textContent?.trim() ?? "",
  }));
  if (audit.rowCount !== 3 || audit.columnCount !== 2 || audit.evidenceFingerprint.length < 16 || !audit.summary.includes("30")) {
    throw new Error(`受控问数浏览器验收失败：${JSON.stringify(audit)}`);
  }
  await page.screenshot({ path: screenshotPath, fullPage: true });
  report.steps.push({ id: "ask-data-real-dataset", detail: audit });
  return audit;
}

async function postJson(url, headers, body, expectedStatus) {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json();
  if (response.status !== expectedStatus) throw new Error(`创建受控问数夹具失败（HTTP ${response.status}）：${JSON.stringify(payload)}`);
  return payload;
}
