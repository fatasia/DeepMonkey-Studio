import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import path from 'node:path';
import playwright from '../../apps/cloud-render-worker/node_modules/playwright-core/index.js';
const requireWeb=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const threeRoot=path.dirname(path.dirname(requireWeb.resolve('three')));
const root=path.resolve('test-output/industrial-solidworks/geometry-20260918/full');
const output=path.join(root,'visual');await mkdir(output,{recursive:true});
const evidence=JSON.parse(await readFile(path.join(root,'evidence.json'),'utf8'));
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');let file;
    if(url.pathname==='/')file=path.resolve('scripts/fixtures/sldprt-preview-check.html');
    else if(url.pathname==='/tokens.css')file=path.resolve('apps/web/src/styles/base.css');
    else if(/^\/model\/[1-5]$/.test(url.pathname))file=path.join(root,`solidworks-sheetmetal-${url.pathname.at(-1)}.glb`);
    else if(url.pathname.startsWith('/three/')){
      file=path.resolve(threeRoot,url.pathname.slice(7));assert.ok(file.startsWith(threeRoot+path.sep));
    }else{res.writeHead(404).end();return;}
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[path.extname(file)]??'application/octet-stream');
    res.end(await readFile(file));
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await playwright.chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const results=[];
try{
  for(const round of [1,2])for(let sample=1;sample<=5;sample++){
    const page=await browser.newPage({viewport:{width:round===1?1280:980,height:800}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?sample=${sample}&round=${round}`);
    await page.waitForFunction(()=>window.result||window.failure);
    const result=await page.evaluate(()=>window.result);assert.deepEqual(errors,[]);assert.ok(result);
    assert.equal(result.triangles,evidence.results[sample-1].triangles);assert.equal(result.meshes,evidence.results[sample-1].meshes);
    await page.screenshot({path:path.join(output,`sample-${sample}-round-${round}.png`)});results.push(result);await page.close();
  }
  await writeFile(path.join(output,'evidence.json'),JSON.stringify({results},null,2));console.log(JSON.stringify({screenshots:results.length,output}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
