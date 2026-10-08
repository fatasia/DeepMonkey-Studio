import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from '../apps/api/node_modules/ws/index.js';
import { newOntologyPackage, datasetSchemaFingerprint } from '../packages/contracts/dist/ontology.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = resolve(process.argv[2] ?? 'test-output/studio-full-editor-hosting/frontend-20261007');
const output = resolve('test-output/studio-full-editor-hosting/live-qa-20261007');
const keep = process.argv.includes('--keep');
await mkdir(output, { recursive: true });
const password = randomBytes(24).toString('hex');
const env = { STUDIO_VERSION: '0.2.0', STUDIO_ONLINE_API_PORT: '44100', STUDIO_ONLINE_WEB_ORIGIN: 'http://localhost:44101',
  STUDIO_ONLINE_POSTGRES_PASSWORD: password, STUDIO_ONLINE_MINIO_USER: `onlineqa${randomBytes(4).toString('hex')}`,
  STUDIO_ONLINE_MINIO_PASSWORD: password, STUDIO_ONLINE_ADMIN_PASSWORD: password,
  STUDIO_ONLINE_SESSION_SECRET: randomBytes(32).toString('hex'), BIM_STUDIO_MINIO_IMAGE: 'deep-monkey-minio:2025.5.24' };
const envFile = join(output, '.env');
await writeFile(envFile, Object.entries(env).map(([key,value]) => `${key}=${value}`).join('\n'));
// Independent credentials require independent data volumes on every verification run.
const composeProject = `studio-online-editor-qa-${Date.now()}-${randomBytes(2).toString('hex')}`;
const composeBase = ['compose', '-p', composeProject, '--env-file', envFile, '-f', 'deploy/online-editor/compose.yml'];
const report = { startedAt: new Date().toISOString(), status: 'running', apiOrigin: 'http://localhost:44100',
  webOrigin: 'http://localhost:44101', base: '/DeepMonkey-Studio/', composeProject, deployedPublicly: false, steps: [] };
async function compose(args) {
  const process = spawn('docker', [...composeBase, ...args], { cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  let log=''; process.stdout.on('data', b=>log+=b); process.stderr.on('data',b=>log+=b);
  const code=await new Promise((done,fail)=>{ process.once('close',done); process.once('error',fail); });
  await writeFile(join(output, `compose-${args[0]}.log`),log); assert.equal(code,0,`Compose ${args[0]} failed; see private QA log`);
}
let token='';
async function api(path, method='GET', body) {
  const response=await fetch(`${report.apiOrigin}${path}`, { method, headers: { Origin: report.webOrigin,
    ...(token?{Authorization:`Bearer ${token}`} : {}), ...(body === undefined || body instanceof FormData ? {} : {'Content-Type':'application/json'}) },
    ...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)}) });
  assert.equal(response.headers.get('access-control-allow-origin'),report.webOrigin,`CORS ${path}`);
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0,300)}`);
  return response;
}
const json=async (path,method,body)=>(await api(path,method,body)).json();
let staticServer;
try {
  await compose(['up','-d','--no-build','--pull','never','--wait','--wait-timeout','180']);
  staticServer=spawn(process.execPath,['scripts/serve-full-editor-qa.mjs',frontend,'44101'],{cwd:root,windowsHide:true,stdio:'ignore'});
  for(let i=0;i<30;i++){ try{ const r=await fetch(`${report.webOrigin}${report.base}`);if(r.ok)break; }catch{} await new Promise(done=>setTimeout(done,100)); }
  const html=await (await fetch(`${report.webOrigin}${report.base}`)).text();
  assert.match(html,/<meta name="studio-api-origin" content="http:\/\/localhost:44100">/);
  const entries=[...html.matchAll(/(?:src|href)="(\/DeepMonkey-Studio\/assets\/[^" ]+\.(?:js|css))"/g)].map(m=>m[1]);
  assert.ok(entries.some(path=>path.endsWith('.js')));
  for(const entry of entries){ const r=await fetch(report.webOrigin+entry); assert.ok(r.ok); assert.match(r.headers.get('content-type'),entry.endsWith('.js')?/javascript/:/css/); }
  assert.ok((await fetch(`${report.webOrigin}${report.base}data?project=qa`,{headers:{Accept:'text/html'}})).ok);
  assert.equal((await fetch(`${report.webOrigin}${report.base}assets/nonexistent.js`)).status,404);
  assert.equal((await fetch(`${report.webOrigin}/api/projects`)).status,404);
  report.steps.push({name:'isolated static subpath, refresh and missing-asset contract',passed:true});
  const options=await fetch(`${report.apiOrigin}/api/auth/login`,{method:'OPTIONS',headers:{Origin:report.webOrigin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,authorization'}});
  assert.equal(options.headers.get('access-control-allow-origin'),report.webOrigin);
  token=(await json('/api/auth/login','POST',{username:'admin',password})).token; assert.ok(token);
  const project=await json('/api/projects','POST',{name:'Full editor online · self-authored QA'}); report.projectId=project.id;
  const form=new FormData(); const modelBytes=await readFile(join(root,'test-output/studio-texture-delivery-20261007/qa-uv-box.glb'));
  form.append('file',new Blob([modelBytes],{type:'model/gltf-binary'}),'self-authored-qa.glb');
  const upload=await json(`/api/projects/${project.id}/models`,'POST',form); let model;
  for(let i=0;i<60;i++){ model=(await json(`/api/projects/${project.id}`)).models.find(m=>m.id===upload.id);if(model?.status==='ready')break;assert.notEqual(model?.status,'failed');await new Promise(done=>setTimeout(done,500)); }
  assert.equal(model.status,'ready'); report.modelId=model.id;
  const asset=await api(model.sourceUrl);const bytes=Buffer.from(await asset.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'),createHash('sha256').update(modelBytes).digest('hex'));
  report.steps.push({name:'cross-origin login, CORS preflight, GLB upload/worker/object readback',passed:true,modelId:model.id});
  const fixture=JSON.parse(await readFile(join(root,'test-fixtures/scene-v1-pure-3d.json'),'utf8'));
  const scene={...fixture,id:randomUUID(),projectId:project.id,name:'Online save and reload',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const scenePath=`/api/projects/${project.id}/scenes/${scene.id}`;
  await json(scenePath,'PUT',scene);assert.equal((await json(scenePath)).name,scene.name);
  const publication=await json(`${scenePath}/publish`,'POST',{expectedSnapshot:await json(scenePath)});assert.equal(publication.sceneId,scene.id);report.sceneId=scene.id;
  report.steps.push({name:'scene save, persistent readback and publication',passed:true,sceneId:scene.id});
  const base=`/api/projects/${project.id}`;
  await json(`${base}/data-connections`,'POST',{id:'online-input',name:'Online QA demonstration',type:'simulation',enabled:true,config:{url:'sim://alarm?rows=12&seed=20261007'}});
  const dataset=await json(`${base}/datasets`,'POST',{id:'online-data',name:'Online demonstration',connectionId:'online-input',fields:[{key:'device_id',type:'string',label:'设备'},{key:'running',type:'boolean',label:'运行'}],computedFields:[],refreshSeconds:0});
  const pipeline=await json(`${base}/data-pipelines`,'POST',{id:'online-flow',name:'Online real processing',nodes:[{id:'input',type:'source',name:'Input',datasetId:dataset.id,position:{x:0,y:0}},{id:'output',type:'output',name:'Output',position:{x:260,y:0}}],edges:[{id:'edge',sourceNodeId:'input',targetNodeId:'output'}]});
  const result=await json(`${base}/data-pipelines/${pipeline.id}/preview`);assert.equal(result.status,'success');assert.equal(result.rows.length,12);
  const pkg=newOntologyPackage('manufacturing','admin');pkg.id=randomUUID();pkg.name='Online QA ontology';
  pkg.objects=[{id:'device',key:'Device',label:'设备',domain:'manufacturing',primaryKeys:['device_id'],properties:[{key:'device_id',type:'string',label:'设备主键',confirmed:true}],sourceBindings:[{kind:'dataset',sourceId:dataset.id,schemaFingerprint:datasetSchemaFingerprint(dataset),fieldMappings:[{propertyKey:'device_id',fieldKey:'device_id'}]}],identityMappings:[],aliases:[],status:'draft',version:0,owner:'admin'}];
  const saved=await json(`${base}/ontology-packages`,'POST',pkg);
  const graph=await json(`${base}/ontology-packages/${saved.id}/graph`,'POST',{root:{type:'object',id:'Device'},depth:1,includeDatasets:true,limit:20});
  assert.ok(graph.nodes.some(node=>node.id==='object:Device')); report.steps.push({name:'real pipeline run and ontology persistence/graph',passed:true,rows:result.rows.length});
  const socket=new WebSocket(`${report.apiOrigin.replace('http:','ws:')}${base}/data/ws`,`bim-studio-auth.${token}`,{headers:{Origin:report.webOrigin}});
  await new Promise((done,fail)=>{socket.once('open',done);socket.once('error',fail);});
  const message=new Promise((done,fail)=>{const timer=setTimeout(()=>fail(new Error('WS event timeout')),5000);socket.once('message',bytes=>{clearTimeout(timer);done(JSON.parse(bytes.toString()));});});
  await json(`${base}/data/events`,'POST',{source:'online-qa',key:'state',value:'running'});
  assert.equal((await message).key,'state'); socket.close(); report.steps.push({name:'authenticated cross-origin WebSocket event',passed:true});
  report.status='passed'; report.fullBrowserAcceptance='pending GPU-safe CUA login/edit/reload checks';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;}
finally{
  if(report.status==='failed') await compose(['logs','--no-color','--tail','100','studio']).catch(()=>{});
  report.finishedAt=new Date().toISOString(); report.keptRunning=keep && report.status==='passed';
  if(!report.keptRunning){staticServer?.kill();await compose(['down','--volumes']).catch(error=>{report.cleanupError=error.message;process.exitCode=1;});}
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
