import assert from "node:assert/strict";

export async function fillSemanticModel(page, name, datasetId) {
  const editor = page.locator(".semantic-editor");
  await editor.getByLabel("模型名称", { exact: true }).fill(name);
  await editor.getByLabel("模型数据来源", { exact: true }).selectOption(`dataset:${datasetId}`);
  await editor.getByRole("button", { name: "新增指标", exact: true }).click();
  const metric = editor.locator(".semantic-definition").first();
  await metric.getByLabel("名称", { exact: true }).fill("总产量");
  await metric.getByLabel("指标字段", { exact: true }).selectOption("amount");
  await metric.locator(".semantic-advanced > summary").click();
  await metric.getByRole("button", { name: "新增默认过滤", exact: true }).click();
  await metric.getByLabel("过滤字段 1", { exact: true }).selectOption("region");
  await metric.getByLabel("值", { exact: true }).fill("华东");
  await editor.getByRole("button", { name: "新增指标", exact: true }).click();
  const count = editor.locator(".semantic-definition").nth(1);
  await count.getByLabel("名称", { exact: true }).fill("记录数");
  await count.getByLabel("聚合方式", { exact: true }).selectOption("count");
  await editor.getByRole("button", { name: "新增指标", exact: true }).click();
  const expression = editor.locator(".semantic-definition").nth(2);
  await expression.getByLabel("名称", { exact: true }).fill("双倍产量");
  await expression.getByLabel("计算来源", { exact: true }).selectOption("expression");
  await expression.getByLabel("指标表达式", { exact: true }).fill("ghost * 2");
  assert.match(await expression.getByRole("alert").innerText(), /ghost/);
  await expression.getByLabel("指标表达式", { exact: true }).fill("amount * 2");
  await editor.locator(".semantic-editor-tabs").getByRole("button", { name: /^维度/ }).click();
  await editor.getByRole("button", { name: "新增维度", exact: true }).click();
  const dimension = editor.locator(".semantic-definition").first();
  await dimension.getByLabel("标识", { exact: true }).fill("region_dim");
  await dimension.getByLabel("名称", { exact: true }).fill("区域与产线");
  await dimension.getByLabel("主字段", { exact: true }).selectOption("region");
  for (const [field, label] of [["region", "区域"], ["line", "产线"]]) {
    await dimension.getByRole("button", { name: "新增钻取层级", exact: true }).click();
    const row = dimension.locator(".semantic-hierarchy-row").last();
    await row.locator("select").selectOption(field);
    await row.getByLabel("层级名称", { exact: true }).fill(label);
  }
  await dimension.getByRole("button", { name: "上移层级 2", exact: true }).click();
  assert.equal(await dimension.getByLabel("层级字段 1", { exact: true }).inputValue(), "line");
  await dimension.getByRole("button", { name: "下移层级 1", exact: true }).click();
  await editor.locator(".semantic-editor-tabs").getByRole("button", { name: /^参数/ }).click();
  await editor.getByRole("button", { name: "新增参数", exact: true }).click();
  const parent = editor.locator(".semantic-definition").first();
  await parent.getByLabel("名称", { exact: true }).fill("区域筛选");
  await parent.getByLabel("参数类型", { exact: true }).selectOption("option");
  await parent.getByLabel("选项来源", { exact: true }).selectOption("static");
  await parent.getByRole("button", { name: "新增固定选项", exact: true }).click();
  await parent.getByLabel("选项值", { exact: true }).fill("华东");
  await parent.getByLabel("显示名", { exact: true }).fill("华东区域");
  await parent.getByLabel("默认值", { exact: true }).fill("华东");
  await editor.getByRole("button", { name: "新增参数", exact: true }).click();
  const child = editor.locator(".semantic-definition").nth(1);
  await child.getByLabel("名称", { exact: true }).fill("产线筛选");
  await child.getByLabel("参数类型", { exact: true }).selectOption("option");
  await child.getByLabel("级联父参数", { exact: true }).selectOption("parameter_1");
  await child.getByLabel("选项来源", { exact: true }).selectOption("dimension");
  await child.getByLabel("选项维度", { exact: true }).selectOption("region_dim");
}

export async function saveSemanticModel(page, expectedStatus = 200) {
  const response = page.waitForResponse(result => result.url().includes("/semantic-models") && ["POST", "PUT"].includes(result.request().method()));
  await page.getByRole("button", { name: "保存语义模型", exact: true }).click();
  const result = await response;
  assert.equal(result.status(), expectedStatus, await result.text());
  return result.json();
}
