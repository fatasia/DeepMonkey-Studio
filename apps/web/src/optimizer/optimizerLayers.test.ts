import {Document,WebIO} from "@gltf-transform/core";
import {describe,it,expect} from "vitest";
import {editOptimizerDocument} from "./optimizerLayers";

function fixture(){
  const doc=new Document(),buffer=doc.createBuffer();
  const positions=doc.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([0,0,0,1,0,0,0,1,0]));
  const mesh=doc.createMesh("shared").addPrimitive(doc.createPrimitive().setAttribute("POSITION",positions));
  const assembly=doc.createNode("机组"),pump=doc.createNode("循环泵").setMesh(mesh),motor=doc.createNode("电机").setMesh(mesh);
  assembly.addChild(pump);doc.createScene("车间").addChild(assembly).addChild(motor);
  return doc;
}
describe("optimizer layers persisted GLB",()=>{
  it("renames the actual node and retains duplicate-name instances through export",async()=>{
    const doc=fixture();editOptimizerDocument(doc,[{id:1,action:"rename",name:"主循环泵"}]);
    const io=new WebIO(),read=await io.readBinary(await io.writeBinary(doc));
    expect(read.getRoot().listNodes().map(node=>node.getName())).toContain("主循环泵");
    expect(read.getRoot().listMeshes()).toHaveLength(1);
    expect(read.getRoot().listScenes()[0]?.listChildren()[0]?.listChildren()[0]?.getName()).toBe("主循环泵");
  });
  it("hides a group in exported scenes and undo restores its subtree",async()=>{
    const base=fixture(),io=new WebIO(),binary=await io.writeBinary(base);
    const doc=await io.readBinary(binary);const layers=editOptimizerDocument(doc,[{id:0,action:"hidden",hidden:true}]);
    expect(layers.find(layer=>layer.name==="循环泵")?.hidden).toBe(true);
    const exported=await io.readBinary(await io.writeBinary(doc));
    expect(exported.getRoot().listScenes()[0]?.listChildren().map(node=>node.getName())).toEqual(["电机"]);
    const undone=await io.readBinary(binary);editOptimizerDocument(undone,[]);
    expect(undone.getRoot().listScenes()[0]?.listChildren()).toHaveLength(2);
  });
  it("deletes descendants without deleting mesh shared by a remaining instance",async()=>{
    const doc=fixture();editOptimizerDocument(doc,[{id:0,action:"delete"}]);
    const io=new WebIO(),read=await io.readBinary(await io.writeBinary(doc));
    expect(read.getRoot().listNodes().map(node=>node.getName())).toEqual(["电机"]);
    expect(read.getRoot().listMeshes()).toHaveLength(1);
    expect(read.getRoot().listNodes()[0]?.getMesh()?.listPrimitives()[0]?.getAttribute("POSITION")?.getCount()).toBe(3);
  });
  it("can show a hidden subtree after downloading and reopening the GLB",async()=>{
    const doc=fixture(),io=new WebIO();editOptimizerDocument(doc,[{id:0,action:"hidden",hidden:true}]);
    const reopened=await io.readBinary(await io.writeBinary(doc));
    const layers=editOptimizerDocument(reopened,[]);
    expect(layers.find(layer=>layer.name==="机组")?.hidden).toBe(true);
    const id=reopened.getRoot().listNodes().findIndex(node=>node.getName()==="机组");
    editOptimizerDocument(reopened,[{id,action:"hidden",hidden:false}]);
    const roundtrip=await io.readBinary(await io.writeBinary(reopened));
    expect(roundtrip.getRoot().listScenes()[0]?.listChildren().map(node=>node.getName())).toEqual(expect.arrayContaining(["机组","电机"]));
  });
  it("rejects stale IDs and empty names without mutating unrelated hierarchy",()=>{
    expect(()=>editOptimizerDocument(fixture(),[{id:99,action:"delete"}])).toThrow("图层已不存在");
    expect(()=>editOptimizerDocument(fixture(),[{id:1,action:"rename",name:"  "}])).toThrow("图层名称");
  });
});
