import {describe,it,expect} from "vitest";
import {optimizerInputFormats} from "./optimizerInputFormats";
describe("optimizer import availability",()=>{
  it("uses local formats without a project",()=>{
    expect(optimizerInputFormats(false,["ifc","rvt"])).toEqual(["glb","gltf"]);
  });
  it("adds only platform formats declared available by the server",()=>{
    expect(optimizerInputFormats(true,["obj","ifc","step","urdf","usd"])).toEqual(expect.arrayContaining(["obj","ifc","step","urdf","usd"]));
    expect(optimizerInputFormats(true,["rvt","rvt","imaginary"])).toEqual(["glb","gltf","rvt"]);
  });
});
