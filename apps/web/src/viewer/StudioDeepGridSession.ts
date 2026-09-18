import * as THREE from "three";
import type { AuthorGridView } from "@bim-studio/deep-engine/webgpu";

/** Only the project's Canvas meter grid, not a general Canvas material bridge. */
export class StudioDeepGridSession {
  private cached: { texture: THREE.Texture; image: HTMLCanvasElement; version: number; width: number; height: number; anisotropy: number; source: AuthorGridView["texture"] } | undefined;
  read(grid: THREE.Object3D | undefined, camera: THREE.Camera, composerActive: boolean, fog: AuthorGridView["fog"] = null): AuthorGridView | undefined {
    if (!grid) return;
    for (let parent: THREE.Object3D | null = grid; parent; parent = parent.parent) if (!parent.visible) return;
    if (!grid.layers.test(camera.layers)) return;
    if (!(grid instanceof THREE.Mesh) || grid.name !== "helper:grid" || !(grid.geometry instanceof THREE.PlaneGeometry)
      || !(grid.material instanceof THREE.MeshBasicMaterial)) throw new Error("Deep 仅支持项目固定地面网格。");
    const material = grid.material, map = material.map;
    if (!material.visible || material.opacity === 0) return;
    if (!composerActive) throw new Error("Deep 地面网格需要作者后处理管线；请保持 WebGL 或启用后处理。");
    if (!(map instanceof THREE.CanvasTexture) || map.colorSpace !== THREE.SRGBColorSpace || !map.flipY || map.premultiplyAlpha
      || map.wrapS !== THREE.ClampToEdgeWrapping || map.wrapT !== THREE.ClampToEdgeWrapping || map.channel !== 0
      || !map.generateMipmaps || map.minFilter !== THREE.LinearMipmapLinearFilter || map.magFilter !== THREE.LinearFilter
      || map.offset.x !== 0 || map.offset.y !== 0 || map.repeat.x !== 1 || map.repeat.y !== 1 || map.rotation !== 0
      || !map.matrixAutoUpdate || material.toneMapped || !material.transparent || !material.depthTest || material.depthWrite
      || material.vertexColors || material.alphaTest !== 0 || material.alphaMap || material.wireframe
      || material.side !== THREE.DoubleSide || material.blending !== THREE.NormalBlending || grid.renderOrder !== -10)
      throw new Error("Deep 地面网格材质不符合固定合同。");
    const image = map.image as HTMLCanvasElement, width = image.width, height = image.height;
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2048 && (value & (value - 1)) === 0)
      || !Number.isSafeInteger(map.anisotropy) || map.anisotropy < 1 || map.anisotropy > 16
      || !Number.isSafeInteger(map.version) || map.version < 0) throw new Error("Deep 地面网格纹理尺寸或版本无效。");
    const color = [material.color.r, material.color.g, material.color.b, material.opacity] as const;
    if (!color.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("Deep 地面网格颜色无效。");
    const parameters = grid.geometry.parameters;
    if (![parameters.width, parameters.height].every(value => Number.isFinite(value) && value > 0)
      || parameters.widthSegments !== 1 || parameters.heightSegments !== 1) throw new Error("Deep 地面网格几何无效。");
    const x = Math.fround(parameters.width / 2), y = Math.fround(parameters.height / 2);
    for (const [name, canonical] of [["position", [-x,y,0, x,y,0, -x,-y,0, x,-y,0]], ["uv", [0,1, 1,1, 0,0, 1,0]]] as const) {
      const actual = grid.geometry.getAttribute(name);
      if (!actual || actual.array.length !== canonical.length || !canonical.every((v, i) => v === actual.array[i]))
        throw new Error("Deep 地面网格顶点已偏离固定平面。");
    }
    if (grid.geometry.drawRange.start !== 0 || grid.geometry.drawRange.count !== Infinity || grid.geometry.index?.count !== 6
      || ![0,2,1, 2,3,1].every((v, i) => v === grid.geometry.index!.array[i])) throw new Error("Deep 地面网格索引无效。");
    const model = new THREE.Matrix4().multiplyMatrices(grid.matrixWorld, new THREE.Matrix4().makeScale(parameters.width, parameters.height, 1));
    if (!model.elements.every(Number.isFinite)) throw new Error("Deep 地面网格矩阵无效。");
    if (!this.cached || this.cached.texture !== map || this.cached.image !== image || this.cached.version !== map.version
      || this.cached.width !== width || this.cached.height !== height || this.cached.anisotropy !== map.anisotropy) {
      const context = image.getContext("2d");
      if (!context) throw new Error("无法读取作者地面网格纹理。");
      // A tainted canvas throws here; candidate/runtime failure restores WebGL.
      const data = new Uint8Array(context.getImageData(0, 0, width, height).data);
      const source = Object.freeze({ id: map.uuid, revision: map.version, semantic: "baseColor" as const, width, height, data,
        sampler: { minFilter: "linear" as const, magFilter: "linear" as const, mipmapFilter: "linear" as const, maxAnisotropy: map.anisotropy } });
      this.cached = { texture: map, image, version: map.version, width, height, anisotropy: map.anisotropy, source };
    }
    return Object.freeze({ texture: this.cached.source, model: Object.freeze([...model.elements]), color, fog: material.fog ? fog : null });
  }
  dispose(): void { this.cached = undefined; }
}
