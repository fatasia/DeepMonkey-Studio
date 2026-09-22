import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import path from 'node:path';
import playwright from '../../apps/cloud-render-worker/node_modules/playwright-core/index.js';
const requireWeb=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const threeRoot=path.dirname(path.dirname(requireWeb.resolve('three')));
const root=path.resolve(process.argv[2]??'test-output/rvt-planar-family-20260918-v2'),output=path.join(root,'visual');
await mkdir(output,{recursive:true});
const evidence=JSON.parse(await readFile(path.join(root,'evidence.json'))),isGroup=evidence.results.some(r=>r.status==='source-group-solid-preview'),isHoled=evidence.results.some(r=>r.status==='source-holed-planar-solid-preview'),accepted=evidence.results.filter(r=>r.status===(isHoled?'source-holed-planar-solid-preview':isGroup?'source-group-solid-preview':'source-planar-solid-preview'));
const samples=isGroup||isHoled?[accepted[0],accepted[Math.floor(accepted.length/2)],accepted.at(-1)].map(row=>({file:row.glb,meshes:row.faces??6,triangles:row.triangles??12})):[{file:accepted.find(r=>r.element===21975).glb,meshes:6,triangles:12},
  {file:accepted.find(r=>r.element===70508).glb,meshes:6,triangles:12},
  {file:'partial-source-solids.glb',meshes:accepted.length*6,triangles:accepted.length*12}];
// Reuse the existing source-mesh inspector; only adapt labels, source Z-up and
// neutral token-based inspection material. No second product viewer.
let html=await readFile('scripts/fixtures/sldprt-preview-check.html','utf8');
html=html.replace('SolidWorks 源显示网格 · 诊断检查','RVT 源平面实体 · 局部几何检查')
  .replace('camera.lookAt(center);','camera.up.set(0,0,1);camera.lookAt(center);')
  .replace('scene.updateMatrixWorld(true);',`scene.updateMatrixWorld(true);gltf.scene.traverse(node=>{if(node.isMesh){node.material.color.set(getComputedStyle(document.body).getPropertyValue('--text-strong').trim());node.material.roughness=.82;node.material.metalness=0;}});`)
  .replace("scene.background=new THREE.Color(getComputedStyle(document.body).getPropertyValue('--bg-0').trim());","scene.background=new THREE.Color(getComputedStyle(document.body).getPropertyValue('--bg-0').trim());scene.fog=new THREE.FogExp2(scene.background,.002);")
  .replace('canvas{display:block}','canvas{display:block}header{font-variant-numeric:tabular-nums}')
  .replace(' · 预览`',' · 局部实体预览`');
const server=createServer(async(req,res)=>{
  try{const url=new URL(req.url,'http://localhost');let file;
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
    if(url.pathname==='/tokens.css')file=path.resolve('apps/web/src/styles/base.css');
    else if(/^\/model\/[1-3]$/.test(url.pathname))file=path.join(root,samples[Number(url.pathname.at(-1))-1].file);
    else if(url.pathname.startsWith('/three/')){file=path.resolve(threeRoot,url.pathname.slice(7));assert.ok(file.startsWith(threeRoot+path.sep));}
    else{res.writeHead(404).end();return;}
    res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css'})[path.extname(file)]??'application/octet-stream');res.end(await readFile(file));
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await playwright.chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'}),results=[];
try{
  for(const round of [1,2])for(let sample=1;sample<=samples.length;sample++){
    const page=await browser.newPage({viewport:{width:round===1?1280:980,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?sample=${sample}&round=${round}`);await page.waitForFunction(()=>window.result||window.failure);
    const result=await page.evaluate(()=>window.result);assert.deepEqual(errors,[]);assert.ok(result);
    assert.equal(result.meshes,samples[sample-1].meshes);assert.equal(result.triangles,samples[sample-1].triangles);
    await page.screenshot({path:path.join(output,`sample-${sample}-round-${round}.png`)});results.push(result);await page.close();
  }
  await writeFile(path.join(output,'evidence.json'),JSON.stringify({source:'actual-generated-glb',results},null,2));console.log(JSON.stringify({screenshots:results.length,output}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
