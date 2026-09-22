import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const base=path.resolve('data/external-assets/industrial-format-plan');
const executable=path.join(base,'build-trial/e57-reader-cli/Release/e57-reader.exe');
const fixtureExe=path.join(path.dirname(executable),'e57-attribute-fixture.exe');
const output=path.resolve(process.argv[2]??'test-output/industrial-e57-attributes-20260918');await mkdir(output);
const samples=path.join(base,'samples/extracted/libE57Format-test-data');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const invoke=(exe,args,success=true)=>{
  const result=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024});
  assert.ifError(result.error);assert.equal(result.status,success?0:1,result.stderr);
  if(!success)assert.equal(result.stdout.trim(),'');return result;
};
const boundary=path.join(output,'boundary.e57');invoke(fixtureExe,[boundary]);
const records=[];
for(const [name,source] of [['cube-double',path.join(samples,'self/ColouredCubeDouble.e57')],['cube-float',path.join(samples,'self/ColouredCubeFloat.e57')],['boundary',boundary]]){
  const runs=[];
  for(const round of [1,2]){
    const directory=path.join(output,`${name}-${round}`),receipt=JSON.parse(invoke(executable,[source,'--output',directory]).stdout);
    assert.equal(receipt.status,'inspect');assert.ok(JSON.stringify(receipt).length<1024);
    const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
    const bytes=await readFile(path.join(directory,'points.ndjson'));
    const blocks=bytes.toString().trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(blocks.every(block=>block.points.length<=4096));
    const points=blocks.flatMap(block=>block.points);assert.equal(points.length,manifest.points);
    assert.equal(manifest.poseApplied,true);assert.equal(manifest.crs,null);
    if(name.startsWith('cube')){
      assert.equal(points.length,7680);assert.deepEqual(manifest.worldBounds,[[-.5,-.5,-.5],[.5,.5,.5]]);
      assert.ok(points.every(point=>point[8]===true&&point[9]===false&&point[10]===0));
      assert.deepEqual([...new Set(points.map(point=>point.slice(4,7).join(',')))].sort(),['0,0,255','0,255,0','255,0,0']);
      assert.ok(points.every(point=>point.slice(4,7).every(color=>color===0||color===255)));
    }else{
      assert.equal(manifest.validPoints,4);assert.equal(manifest.invalidPoints,2);assert.equal(blocks.length,2);
      for(const [scan,block] of blocks.entries()){
        assert.equal(block.scan,scan);
        assert.deepEqual(block.points[0],[0,999998.125+scan,-1999999.25,3000003.5,65535,1234,0,12.5,true,true,0]);
        assert.deepEqual(block.points[1],[1,999998.125+scan,-1999998.25,3000003.5,65535,1234,0,null,false,false,0]);
        assert.deepEqual(block.points[2],[2,null,null,null,65535,1234,0,14.5,true,true,2]);
      }
    }
    const unchanged=hash(bytes);invoke(executable,[source,'--output',directory],false);
    assert.equal(hash(await readFile(path.join(directory,'points.ndjson'))),unchanged,'existing output must survive rejected overwrite');
    runs.push({manifest,pointSha256:hash(bytes)});
  }
  assert.deepEqual(runs[0],runs[1]);records.push({name,sourceSha256:hash(await readFile(source)),...runs[0]});
}
for(const file of ['bad-crc.e57','InvalidCVHeader.e57','InvalidFileLength.e57','NoPrototype.e57','ZeroPointsInvalid.e57']){
  const destination=path.join(output,`reject-${file}`);invoke(executable,[path.join(samples,'self',file),'--output',destination],false);
  await assert.rejects(stat(destination),{code:'ENOENT'});await assert.rejects(stat(destination+'.partial'),{code:'ENOENT'});
}
await writeFile(path.join(output,'evidence.json'),JSON.stringify({status:'inspect-intermediate-only',readerSha256:hash(await readFile(executable)),records,rejected:5},null,2));
console.log(JSON.stringify({output,positive:3,rounds:2,rejected:5}));
