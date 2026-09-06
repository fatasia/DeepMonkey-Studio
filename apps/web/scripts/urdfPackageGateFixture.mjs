import JSZip from "jszip";
import { URDF_GATE_SOURCE } from "./urdfGateFixture.mjs";

export async function urdfPackageGateFixture() {
  const mesh = "solid shoulder\nfacet normal 0 0 1\nouter loop\nvertex -0.1 -0.1 0\nvertex 0.1 -0.1 0\nvertex 0 0.1 0\nendloop\nendfacet\nendsolid shoulder";
  const urdf = URDF_GATE_SOURCE.replace('<sphere radius="0.13"/>', '<mesh filename="package://fixture/meshes/shoulder.stl"/>');
  const zip = new JSZip().file("fixture/robot.urdf", urdf).file("fixture/alternate.urdf", URDF_GATE_SOURCE).file("fixture/meshes/shoulder.stl", mesh);
  return { entryPath: "fixture/robot.urdf", bytes: Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })) };
}
