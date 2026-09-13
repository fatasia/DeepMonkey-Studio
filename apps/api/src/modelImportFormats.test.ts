import {describe,it,expect} from "vitest";
import {ConversionQueue} from "./conversion.js";
import type {AppConfig} from "./config.js";
import type {MetadataStore} from "./store.js";
import type {ObjectStore} from "./objects.js";
import Fastify from "fastify";
import {registerModelAssetRoutes} from "./modelAssetRoutes.js";
const formats=(config:unknown)=>new ConversionQueue({} as MetadataStore,config as AppConfig,{} as ObjectStore).listImportFormats();
describe("available model inputs",()=>{
  it("serves the queue's real formats for an existing project and rejects missing projects",async()=>{
    const app=Fastify();
    await registerModelAssetRoutes(app,{store:{getProject:(id:string)=>id==="project-a"?{id}:undefined} as MetadataStore,queue:{listImportFormats:()=>["glb","dwg"]} as ConversionQueue,objects:{} as ObjectStore,dataDir:"unused",config:{} as AppConfig});
    expect((await app.inject({method:"GET",url:"/api/projects/project-a/model-import-formats"})).json()).toEqual(["glb","dwg"]);
    expect((await app.inject({method:"GET",url:"/api/projects/project-b/model-import-formats"})).statusCode).toBe(404);
    await app.close();
  });
  it("omits unconfigured proprietary converters and includes built-in geometry providers",()=>{
    const actual=formats({dwg:{},rvt:{},industrialCad:{}});
    expect(actual).toEqual(expect.arrayContaining(["glb","gltf","obj","step","stp","ifc","usd","urdf"]));
    for(const format of ["dwg","rvt","jt","x_t","x_b"])expect(actual).not.toContain(format);
  });
  it("includes configured external providers without changing converter cards",()=>{
    expect(formats({dwg:{command:"dwg"},rvt:{command:"rvt"},industrialCad:{command:"cad"}})).toEqual(expect.arrayContaining(["dwg","rvt","x_t","x_b","jt"]));
  });
});
