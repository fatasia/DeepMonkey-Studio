import { Document } from "@gltf-transform/core";
import * as THREE from "three";
export function giFixture() {
  const document = new Document(), buffer = document.createBuffer(), scene = document.createScene();
  const floor = new THREE.PlaneGeometry(4,4).rotateX(-Math.PI/2);
  const wall = new THREE.PlaneGeometry(4,3).rotateY(Math.PI/2).translate(-2,1.5,0);
  const rear = new THREE.PlaneGeometry(4,3).translate(0,1.5,-2);
  for (const [index,geometry] of [floor,wall,rear].entries()) {
    const material = document.createMaterial().setBaseColorFactor(index===1?[.75,.025,.015,1]:[.75,.75,.75,1]).setMetallicFactor(0).setRoughnessFactor(.85);
    const primitive = document.createPrimitive().setMaterial(material);
    for (const [name,source,size] of [["POSITION","position","VEC3"],["NORMAL","normal","VEC3"]] as const) {
      primitive.setAttribute(name,document.createAccessor().setBuffer(buffer).setType(size).setArray(new Float32Array(geometry.getAttribute(source).array)));
    }
    primitive.setIndices(document.createAccessor().setBuffer(buffer).setType("SCALAR").setArray(new Uint32Array(geometry.index!.array)));
    scene.addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)));geometry.dispose();
  }
  return document;
}
