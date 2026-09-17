import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createIsolatedStudioGate } from './isolatedStudioGate.mjs';
import { uploadModel, observeDiagnostics, themeContext } from './gateModelInstancesSupport.mjs';
import { jtMaterialPair } from './jtMaterialVisualFixture.mjs';

const gate = await createIsolatedStudioGate('jt-material-visual', { webRoot: 'test-output/jt-current-web-20260917' });
const report = { output: gate.output, cases: [] };
console.log(JSON.stringify({ output: gate.output }));
try {
  const bytes = await readFile(resolve('test-output/jt-material-path-20260917/voyager-coffee-maker-jt9.5.jt/geometry.glb'));
  const pair = await jtMaterialPair(bytes);
  for (const [theme, width, kind] of [['dark', 1920, 'full'], ['light', 1280, 'full'], ['dark',1920,'pair'], ['light',1280,'pair']]) {
    const entry = { theme, width, kind, errors: [], driverWarnings: [], expectedNetworkErrors: [] }; report.cases.push(entry);
    const context = await themeContext(gate, theme, width); const page = await context.newPage(); page.setDefaultTimeout(45000);
    observeDiagnostics(page, entry);
    try {
      const project = await gate.json('POST', '/api/projects', { name: `JT 材质路径 ${theme}` });
      const model = await uploadModel(gate, project.id, page, `CoffeeMaker-${kind}.glb`, kind === 'pair' ? pair : bytes);
      await gate.loginPage(page); await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.getByRole('button', { name: '新建场景', exact: true }).click();
      await page.getByLabel('场景名称').fill('CoffeeMaker 材质与实例');
      const pending = page.waitForResponse(r => r.url().endsWith(`/api/projects/${project.id}/applications`) && r.request().method() === 'POST');
      await page.getByRole('button', { name: '创建并进入', exact: true }).click();
      const application = await (await pending).json();
      const scene = await gate.json('GET', `/api/projects/${project.id}/scenes/${application.scenes[0].id}`);
      scene.models = [{modelId:model.id,name:'CoffeeMaker 源材质',visible:true,opacity:1,transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}}}];
      application.scenes[0].models = scene.models;
      await gate.json('PUT', `/api/projects/${project.id}/applications/${application.metadata.id}/workspace`, { application, scene });
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/scenes/${application.scenes[0].id}`);
      await page.locator('.viewport canvas').waitFor();
      await page.waitForTimeout(2500);
      await page.getByRole('button', { name: '适应全部', exact: true }).click();
      await page.waitForTimeout(1800);
      await page.screenshot({path:resolve(gate.output,`${theme}-${width}-${kind}-overview.png`)});
      const row = page.locator(`.model-tree-item[data-model-id="${model.id}"]`);
      await row.locator('.asset-main').click();
      await page.waitForTimeout(250);
      entry.text = (await page.locator('body').innerText()).slice(-18000);
      await page.screenshot({path:resolve(gate.output,`${theme}-${width}-${kind}-selected.png`)});
      await row.locator('.asset-main').click();
      await row.getByRole('button', {name:'隐藏',exact:true}).click();
      await row.getByRole('button', {name:'显示',exact:true}).click();
      assert.deepEqual(entry.errors, []);
      entry.passed = true;
    } catch (error) {
      await page.screenshot({path:resolve(gate.output,`${theme}-${width}-failure.png`)});
      entry.text = (await page.locator('body').innerText()).slice(-18000);
      entry.failure = String(error); throw error;
    } finally { await context.close(); }
  }
} finally {
  await writeFile(resolve(gate.output,'report.json'), JSON.stringify(report,null,2));
  await gate.close();
}
