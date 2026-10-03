import { expect, it } from "vitest";
import * as THREE from "three";
import { observeDeepFragment } from "./c8FragmentObservablesShader.js";
import { explicitPlaneDerivatives, observeDeepExplicitDerivative } from "./c8ExplicitDerivativeShader.js";

it("reconstructs perspective-correct normalized triangle normals including helper extrapolation", () => {
  // Screen barycentrics at deliberately subpixel triangle vertices. Inverse W
  // differs strongly across the primitive, so treating perspective normals as
  // affine would fail; the independent oracle evaluates perspective ratios.
  const a = [198.2, 64.1], b = [198.6, 64.2], c = [198.4, 64.7];
  const values = [[.2, .7, .6], [.8, -.1, .5], [-.4, .5, .9]], inverseW = [.08, .3, .12];
  const bary = (x: number, y: number) => {
    const determinant = (b[1]! - c[1]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[1]! - c[1]!);
    const u = ((b[1]! - c[1]!) * (x - c[0]!) + (c[0]! - b[0]!) * (y - c[1]!)) / determinant;
    const v = ((c[1]! - a[1]!) * (x - c[0]!) + (a[0]! - c[0]!) * (y - c[1]!)) / determinant;
    return [u, v, 1 - u - v];
  };
  const sample = (x: number, y: number) => {
    const weights = bary(x, y), divisor = weights.reduce((sum, value, i) => sum + value * inverseW[i]!, 0);
    const raw = [0, 1, 2].map(channel => weights.reduce((sum, value, i) => sum + value * inverseW[i]! * values[i]![channel]!, 0) / divisor);
    return { numerator: raw.map(v => v * divisor), normal: raw.map(v => v / Math.hypot(...raw)) };
  };
  // This quad sits outside most of the tiny primitive, exercising same-face
  // extrapolation rather than accidentally reading visible adjacent triangles.
  const expected = [[198.5, 64.5], [199.5, 64.5], [198.5, 65.5], [199.5, 65.5]].map(([x, y]) => sample(x!, y!));
  for (let lane = 0; lane < 4; lane++) {
    const position = [198.5 + lane % 2, 64.5 + Math.floor(lane / 2)] as const;
    const base = sample(...position), right = sample(position[0] + 1, position[1]), down = sample(position[0], position[1] + 1);
    const dx = right.numerator.map((v, i) => v - base.numerator[i]!), dy = down.numerator.map((v, i) => v - base.numerator[i]!);
    const result = explicitPlaneDerivatives(base.numerator as [number, number, number], dx as [number, number, number], dy as [number, number, number], position);
    result.corners.forEach((normal, i) => normal.forEach((v, channel) => expect(v).toBeCloseTo(expected[i]!.normal[channel]!, 10)));
  }
});

it("returns bottom-row and left-column deltas consistently at each quad lane", () => {
  const numerator = [1, 2, 3] as const, dx = [.5, .1, -.3] as const, dy = [-.1, .4, .2] as const;
  const reference = explicitPlaneDerivatives(numerator, dx, dy, [0.5, 0.5]);
  for (let lane = 0; lane < 4; lane++) {
    const shifted = numerator.map((v, i) => v + dx[i]! * (lane % 2) + dy[i]! * Math.floor(lane / 2)) as [number, number, number];
    const result = explicitPlaneDerivatives(shifted, dx, dy, [lane % 2 + .5, Math.floor(lane / 2) + .5]);
    result.dx.forEach((v, i) => expect(v).toBeCloseTo(reference.dx[i]!, 12));
    result.dy.forEach((v, i) => expect(v).toBeCloseTo(reference.dy[i]!, 12));
  }
  expect(reference.dx).not.toEqual(reference.corners[0]!.map((v, i) => Math.abs(v - reference.corners[1]![i]!)));
});

it("matches same-primitive ray-plane interpolation across cameras and mesh transforms", () => {
  const geometry = new THREE.SphereGeometry(.65, 24, 16), face = 172;
  const ids = [0, 1, 2].map(i => geometry.index!.array[face * 3 + i]!);
  const cases = [
    { eye: [0, 0, 9], position: [2, 1, 0], scale: [1, 1, 1], rotation: [0, 0, 0], fov: 45 },
    { eye: [3, 2, 5.4], position: [-.4, .2, -.1], scale: [1.3, .7, 1.1], rotation: [.2, -.4, .3], fov: 37 },
    { eye: [-2, 3, 12], position: [.3, -.4, .5], scale: [.8, 1.5, .9], rotation: [-.3, .5, .2], fov: 63 },
  ];
  for (const variant of cases) {
    const camera = new THREE.PerspectiveCamera(variant.fov, 320 / 192, .1, 100);
    camera.position.fromArray(variant.eye); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
    const mesh = new THREE.Mesh(geometry); mesh.position.fromArray(variant.position); mesh.scale.fromArray(variant.scale);
    mesh.rotation.set(...variant.rotation as [number, number, number]); mesh.updateMatrixWorld(true);
    const world = ids.map(id => new THREE.Vector3().fromBufferAttribute(geometry.attributes.position!, id).applyMatrix4(mesh.matrixWorld));
    const modelNormal = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld), viewNormal = new THREE.Matrix3().getNormalMatrix(camera.matrixWorldInverse);
    // Production vertex normal output is normalized after the model transform.
    const normals = ids.map(id => new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal!, id).applyMatrix3(modelNormal).normalize());
    const clips = world.map(p => new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix));
    const screen = clips.map(p => new THREE.Vector3((p.x / p.w + 1) * 160, (1 - p.y / p.w) * 96, 0));
    const plane = new THREE.Plane().setFromCoplanarPoints(...world as [THREE.Vector3, THREE.Vector3, THREE.Vector3]);
    const triangle = new THREE.Triangle(...world as [THREE.Vector3, THREE.Vector3, THREE.Vector3]);
    const projected = new THREE.Triangle(...screen as [THREE.Vector3, THREE.Vector3, THREE.Vector3]);
    const center = screen.reduce((v, p) => v.add(p), new THREE.Vector3()).multiplyScalar(1 / 3);
    const origin = [Math.floor(center.x / 2) * 2 + .5, Math.floor(center.y / 2) * 2 + .5] as const;
    const numeratorAt = (x: number, y: number) => {
      const bary = projected.getBarycoord(new THREE.Vector3(x, y, 0), new THREE.Vector3())!;
      return normals.reduce((v, normal, i) => v.addScaledVector(normal, bary.getComponent(i) / clips[i]!.w), new THREE.Vector3()).applyMatrix3(viewNormal).toArray() as [number, number, number];
    };
    const rayNormal = (x: number, y: number) => {
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(x / 160 - 1, 1 - y / 96), camera);
      const point = ray.ray.intersectPlane(plane, new THREE.Vector3())!;
      const bary = triangle.getBarycoord(point, new THREE.Vector3())!;
      return normals.reduce((v, normal, i) => v.addScaledVector(normal, bary.getComponent(i)), new THREE.Vector3()).applyMatrix3(viewNormal).normalize().toArray();
    };
    const base = numeratorAt(...origin), right = numeratorAt(origin[0] + 1, origin[1]), down = numeratorAt(origin[0], origin[1] + 1);
    const result = explicitPlaneDerivatives(base, right.map((v, i) => v - base[i]!) as [number, number, number], down.map((v, i) => v - base[i]!) as [number, number, number], origin);
    result.corners.forEach((normal, lane) => {
      const expected = rayNormal(origin[0] + lane % 2, origin[1] + Math.floor(lane / 2));
      normal.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));
    });
  }
  geometry.dispose();
});

it("builds isolated candidates with unchanged source identity and no new resources", () => {
  for (const mode of ["geometry", "single", "rough-single", "view-normal", "abs-dx", "abs-dy"] as const) {
    const base = observeDeepFragment(mode), candidate = observeDeepExplicitDerivative(mode);
    expect(candidate.originalHash).toBe(base.originalHash);
    expect(candidate.instrumentedHash).not.toBe(base.instrumentedHash);
    expect(candidate.qualityCertified).toBe(false);
    expect(candidate.code.match(/deepC8SeedExplicitDerivative\(v.normal, v.clip\)/g)).toHaveLength(11);
    expect(candidate.code.match(/dpdxFine\(/g)).toHaveLength(1);
    expect(candidate.code.match(/dpdyFine\(/g)).toHaveLength(1);
    expect(candidate.code).not.toMatch(/quadBroadcast|quadSwap|enable subgroups/);
    expect(candidate.code.match(/@group\([^]*?@binding\([^)]*\)/g)).toEqual(base.code.match(/@group\([^]*?@binding\([^)]*\)/g));
  }
});

it("rejects invalid CPU inputs before reporting derivative values", () => {
  expect(() => explicitPlaneDerivatives([0, 0, 0], [0, 0, 0], [0, 0, 0], [.5, .5])).toThrow("Degenerate");
  expect(() => explicitPlaneDerivatives([NaN, 0, 1], [0, 0, 0], [0, 0, 0], [.5, .5])).toThrow("Non-finite");
});
