import fs from "node:fs/promises";
import { SceneTransformGraph, SceneTransformSpatialBridge, type SceneTransformNodeInput } from "../packages/deep-engine/src/scene/index.js";
import { LooseOctreeIndex } from "../packages/deep-engine/src/spatial/index.js";
import { prepareSceneCommandTransaction, commitSceneCommandTransaction, parseSceneCommand, type SceneCommandTransactionRequest } from "../packages/scene-sdk/src/index.js";
import { SceneGraphTransactionDriver } from "../apps/web/src/commands/SceneGraphTransactionDriver.js";

// Repository CLI for the existing graph-node and SDK transaction contracts.
// Geometry/assets, world-file persistence and Viewer hierarchy editing are outside this slice.
const args=process.argv.slice(2);
const value=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const nodesPath=value("--nodes"),requestPath=value("--request"),outputPath=value("--out");
if(!nodesPath||!requestPath)throw Error("Usage: native-author-parent.mts --nodes graph-nodes.json --request scene-transaction.json [--out result.json] [--cancel]");
const nodes:unknown=JSON.parse(await fs.readFile(nodesPath,"utf8"));
if(!Array.isArray(nodes))throw Error("--nodes must contain SceneTransformNodeInput<string>[] JSON.");
const graph=new SceneTransformGraph<string>();
graph.transaction(()=>{for(const input of nodes){if(!input||typeof input!=="object"||typeof input.id!=="string")throw Error("Graph node id must be a string.");graph.create(input as SceneTransformNodeInput<string>);}});
const index=new LooseOctreeIndex<string>({bounds:{min:[-1_000_000,-1_000_000,-1_000_000],max:[1_000_000,1_000_000,1_000_000]}});
const spatial=new SceneTransformSpatialBridge({kind:"octree",target:index});spatial.apply(graph.flush());
const request=JSON.parse(await fs.readFile(requestPath,"utf8")) as SceneCommandTransactionRequest;
const prepared=prepareSceneCommandTransaction(request);
if(prepared.status!=="prepared"){console.log(JSON.stringify(prepared,null,2));process.exitCode=1;}
else{
 const abort=new AbortController(),cancel=()=>abort.abort();process.once("SIGINT",cancel);
 if(args.includes("--cancel"))abort.abort();
 try{
  const driver=new SceneGraphTransactionDriver(graph,{sceneId:prepared.plan.sceneId,transactionId:prepared.plan.id,baseRevision:prepared.plan.baseRevision,parser:{parse:parseSceneCommand}});
  const outcome=await commitSceneCommandTransaction(prepared.plan,driver,abort.signal);
  if(driver.finalFlush)spatial.apply(driver.finalFlush);
  const result={outcome,nodes:nodes.map(input=>graph.getNode(input.id)),spatialBounds:nodes.map(input=>({id:input.id,bounds:index.getBounds(input.id)}))};
  const json=JSON.stringify(result,null,2)+"\n";if(outputPath)await fs.writeFile(outputPath,json);console.log(json);
  if(outcome.status!=="committed")process.exitCode=1;
 }finally{process.removeListener("SIGINT",cancel);}
}
