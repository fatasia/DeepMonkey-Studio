import assert from 'node:assert/strict';
import { mkdir,writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import playwright from '../apps/cloud-render-worker/node_modules/playwright-core/index.js';
const requireWeb=createRequire(new URL('../apps/web/package.json',import.meta.url));
const { createServer } = await import(pathToFileURL(requireWeb.resolve('vite')).href);
const sharp=requireWeb('sharp'),output=path.resolve(process.argv[2]??'test-output/lightmap-gi-20260918');await mkdir(output,{recursive:true});
const server=await createServer({root:path.resolve('apps/web'),configFile:false,server:{host:'127.0.0.1',port:0},logLevel:'error'});await server.listen();
const browser=await playwright.chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const evidence=[];
try{
  for(const [round,width] of [[1,1280],[2,980]]){
    const page=await browser.newPage({viewport:{width,height:800}}),errors=[],driverWarnings=[];
    page.on('pageerror',error=>errors.push(error.message));page.on('console',entry=>{
      if(!['warning','error'].includes(entry.type()))return;
      const text=entry.text();
      if(entry.type()==='warning'&&text.startsWith('THREE.WebGLProgram: Program Info Log:')&&text.replace('THREE.WebGLProgram: Program Info Log:','').trim().split('\n').every(line=>/^\(\d+,\d+-\d+\): warning X4122: sum of .* cannot be represented accurately in double precision$/.test(line.trim())))driverWarnings.push(text);
      else errors.push(text);
    });
    await page.goto(`${server.resolvedUrls.local[0]}scripts/gi-bake-check.html`);
    await page.waitForFunction(()=>window.result||window.failure,{},{timeout:60000});
    assert.deepEqual(errors,[]);const result=await page.evaluate(()=>window.result);assert.ok(result);
    for(const panel of result)for(const corner of panel.projectedBounds)assert.ok(corner.every(value=>Math.abs(value)<1),'whole model must fit the camera frustum');
    await page.screenshot({path:path.join(output,`round-${round}.png`)});
    const off=await sharp(await page.locator('#off canvas').screenshot()).raw().toBuffer(),on=await sharp(await page.locator('#on canvas').screenshot()).raw().toBuffer();
    assert.equal(off.length,on.length);let changed=0;for(let i=0;i<off.length;i++)if(off[i]!==on[i])changed++;
    assert.ok(changed>1000,'GI must change actual rendered pixels');
    const files=await page.evaluate(()=>window.files),hashes=[];
    for(const [index,bytes] of files.entries()){const binary=Buffer.from(bytes);hashes.push(createHash('sha256').update(binary).digest('hex'));await writeFile(path.join(output,`round-${round}-gi-${index?'on':'off'}.glb`),binary);}
    evidence.push({round,width,result,changedChannels:changed,glbSha256:hashes,driverWarnings});await page.close();
  }
  assert.deepEqual(evidence[0].glbSha256,evidence[1].glbSha256,'repeat bake must preserve GLB identity');
  await writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser.close();await server.close();}
