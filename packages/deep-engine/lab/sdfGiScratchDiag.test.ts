// 临时诊断(任务 GI 收尾 ①:变化区子域归因)——跑完即删,不入库。
import { describe, it } from "vitest";
import { bakeSdfSceneGrid } from "../src/gi/sdfSceneBake.js";
import { deriveSdfGiProbeLattice } from "../src/gi/sdfGiSceneAdapter.js";
import { probeLatticeBounds } from "../src/gi/sdfGiBakePlan.js";
import { resolveSdfSkyVisibilityTraceConfig, traceSdfSkyVisibility } from "../src/gi/sdfSkyVisibility.js";
import { packInitialSdfGiRecords, planSdfGiProbeWindow } from "../src/gi/sdfGiPacking.js";
import { sdfGiPublishLevel } from "../src/gi/sdfGiPublish.js";
import { sampleIrradianceProbeClipmap, type IrradianceProbeRecord } from "../src/lighting/probeClipmapSampling.js";
import { probeOcclusionDirection } from "../src/rayTracing/probeOcclusionRayExtension.js";
import { buildReferenceRoomScene } from "../src/lighting/probeReferenceScene.js";

describe("sdf gi scratch diag", () => {
  it("replicates record chain + center-row sampling", () => {
    const boxes = buildReferenceRoomScene().boxes;
    const instances = boxes.map((box, index) => {
      const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max;
      return {
        id: `box-${index}`,
        mesh: {
          positions: Float32Array.from([
            x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
            x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
          ]),
          indices: Uint32Array.from([
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
            3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
          ]),
        },
      };
    });
    const bake = bakeSdfSceneGrid(instances, { cellSize: 0.15, instanceDomain: "scene" });
    const grid = bake.grid;
    console.log("grid", grid.origin, grid.dimensions, grid.cellSize);
    const config = resolveSdfSkyVisibilityTraceConfig(grid);
    console.log("trace config", config);
    const bounds = probeLatticeBounds(grid);
    const spacing = Math.max(grid.cellSize * 4, 0.25);
    const lattice = deriveSdfGiProbeLattice(bounds, spacing, 4096);
    console.log("lattice dims", lattice.dimensions, "spacing", lattice.spacing,
      "first", lattice.positions[0], "last", lattice.positions[lattice.positions.length - 1]);
    const probeCount = lattice.positions.length;
    const directionCount = 16;
    const directions: [number, number, number][] = [];
    for (let d = 0; d < directionCount; d++) directions.push([...probeOcclusionDirection(d, directionCount)]);
    const visibilities = traceSdfSkyVisibility(grid, lattice.positions, directions);
    // 记录状态:packInitialSdfGiRecords 布局 → IrradianceProbeRecord 数组,模拟 16 窗口×64。
    const initial = packInitialSdfGiRecords(probeCount, config.maxDistance);
    const stride = 24;
    const records: (IrradianceProbeRecord | undefined)[] = lattice.positions.map((_, probe) => ({
      irradiance: [initial[probe * stride]!, initial[probe * stride + 1]!, initial[probe * stride + 2]!],
      validity: initial[probe * stride + 3]!,
      meanDistance: initial[probe * stride + 4]!,
      distanceVariance: initial[probe * stride + 5]!,
    }));
    const sky = [1, 0.9, 0.8] as const;
    const alpha = 0.1;
    let dispatched = 0;
    for (let frame = 0; frame < 16; frame++) {
      const window = planSdfGiProbeWindow(probeCount, 64, dispatched);
      dispatched += 1;
      for (let slot = 0; slot < window.count; slot++) {
        const probe = (window.offset + slot) % probeCount;
        const previous = records[probe]!;
        if (previous.validity === 0) continue;
        const first = probe * directionCount;
        let c0 = 0, r = 0, g = 0, b = 0;
        for (let d = 0; d < directionCount; d++) {
          const v = visibilities[first + d]!;
          c0 += v;
          r += v * sky[0]; g += v * sky[1]; b += v * sky[2];
        }
        const target = [r / directionCount, g / directionCount, b / directionCount] as const;
        records[probe] = {
          ...previous,
          irradiance: [
            previous.irradiance[0]! + (target[0] - previous.irradiance[0]!) * alpha,
            previous.irradiance[1]! + (target[1] - previous.irradiance[1]!) * alpha,
            previous.irradiance[2]! + (target[2] - previous.irradiance[2]!) * alpha,
          ],
          occlusionFloor: c0 / directionCount,
        };
      }
      if (frame === 0 || frame === 15) {
        const floors = records.map(record => record?.occlusionFloor ?? 0);
        console.log(`frame ${frame}: floor min=${Math.min(...floors).toFixed(4)} max=${Math.max(...floors).toFixed(4)} mean=${(floors.reduce((a, b) => a + b, 0) / probeCount).toFixed(4)}`);
      }
    }
    const level = sdfGiPublishLevel(lattice.positions[0]!, lattice.spacing, lattice.dimensions);
    console.log("level", level.origin, level.max, level.gridSize);
    // 中心行采样:sdfGiShade 相机口径。
    const width = 320, height = 240;
    const eye: [number, number, number] = [1.4, 1.7, 3.0];
    const target: [number, number, number] = [5.2, 1.1, 3.0];
    const tanHalf = Math.tan(Math.PI / 8);
    const forward = normalize3(sub3(target, eye));
    const right = normalize3(cross3(forward, [0, 1, 0]));
    const up = cross3(right, forward);
    const field = grid.distances;
    const [nx, ny, nz] = grid.dimensions;
    const [ox, oy, oz] = grid.origin;
    const cs = grid.cellSize;
    const maxX = nx - 1, maxY = ny - 1, maxZ = nz - 1;
    const at = (x: number, y: number, z: number): number =>
      field[(Math.min(Math.max(z, 0), maxZ) * ny + Math.min(Math.max(y, 0), maxY)) * nx
        + Math.min(Math.max(x, 0), nx - 1)]!;
    const distanceAt = (px: number, py: number, pz: number): number => {
      const qx = (px - ox) / cs, qy = (py - oy) / cs, qz = (pz - oz) / cs;
      if (qx < 0 || qy < 0 || qz < 0 || qx > maxX || qy > maxY || qz > maxZ) return 1e6;
      const lx = Math.floor(qx), ly = Math.floor(qy), lz = Math.floor(qz);
      const fx = qx - lx, fy = qy - ly, fz = qz - lz;
      const d000 = at(lx, ly, lz), d100 = at(lx + 1, ly, lz);
      const d010 = at(lx, ly + 1, lz), d110 = at(lx + 1, ly + 1, lz);
      const d001 = at(lx, ly, lz + 1), d101 = at(lx + 1, ly, lz + 1);
      const d011 = at(lx, ly + 1, lz + 1), d111 = at(lx + 1, ly + 1, lz + 1);
      const x0 = d000 + (d100 - d000) * fx, x1 = d010 + (d110 - d010) * fx;
      const x2 = d001 + (d101 - d001) * fx, x3 = d011 + (d111 - d011) * fx;
      const y0 = x0 + (x1 - x0) * fy, y1 = x2 + (x3 - x2) * fy;
      return y0 + (y1 - y0) * fz;
    };
    const row = Math.floor(height * 0.5);
    for (let sample = 0; sample < 64; sample++) {
      const x = Math.floor(width * (sample + 0.5) / 64);
      const u = ((x + 0.5) / width * 2 - 1) * tanHalf;
      const v = (1 - (row + 0.5) / height * 2) * tanHalf;
      const dx = forward[0] + right[0] * u + up[0] * v;
      const dy = forward[1] + right[1] * u + up[1] * v;
      const dz = forward[2] + right[2] * u + up[2] * v;
      const length = Math.hypot(dx, dy, dz);
      const dirX = dx / length, dirY = dy / length, dirZ = dz / length;
      let travel = 0, hitX = 0, hitY = 0, hitZ = 0, hit = false;
      for (let step = 0; step < 128; step++) {
        const px = eye[0] + dirX * travel, py = eye[1] + dirY * travel, pz = eye[2] + dirZ * travel;
        const distance = distanceAt(px, py, pz);
        if (distance < 0.0015) { hitX = px; hitY = py; hitZ = pz; hit = true; break; }
        travel += Math.min(distance * 0.95, 1);
        if (travel > 40) break;
      }
      if (!hit) { console.log(`sample ${sample}: miss`); continue; }
      const h = cs * 0.5;
      const gx = distanceAt(hitX + h, hitY, hitZ) - distanceAt(hitX - h, hitY, hitZ);
      const gy = distanceAt(hitX, hitY + h, hitZ) - distanceAt(hitX, hitY - h, hitZ);
      const gz = distanceAt(hitX, hitY, hitZ + h) - distanceAt(hitX, hitY, hitZ - h);
      const normal = normalize3([gx, gy, gz]);
      const gi = sampleIrradianceProbeClipmap({
        worldPosition: [hitX + normal[0] * 0.06, hitY + normal[1] * 0.06, hitZ + normal[2] * 0.06],
        worldNormal: normal, levels: [level], records,
        environmentFallback: [0, 0, 0],
      });
      console.log(`sample ${sample}: hit=(${hitX.toFixed(2)},${hitY.toFixed(2)},${hitZ.toFixed(2)})`
        + ` n=(${normal.map(value => value.toFixed(2)).join(",")})`
        + ` irr=[${gi.irradiance.map(value => value.toFixed(4)).join(",")}]`
        + ` w=${gi.accumulatedWeight.toFixed(4)} probes=${gi.sampledProbeCount} fallback=${gi.fallback}`);
    }
    // 诊断:变化区边界样本的 8 探针权重分解(取 sample 22 与 30)。
    for (const sample of [10, 22, 30, 50]) {
      const x = Math.floor(width * (sample + 0.5) / 64);
      const u = ((x + 0.5) / width * 2 - 1) * tanHalf;
      const v = (1 - (row + 0.5) / height * 2) * tanHalf;
      const dx = forward[0] + right[0] * u + up[0] * v;
      const dy = forward[1] + right[1] * u + up[1] * v;
      const dz = forward[2] + right[2] * u + up[2] * v;
      const length = Math.hypot(dx, dy, dz);
      const dirX = dx / length, dirY = dy / length, dirZ = dz / length;
      let travel = 0, hitX = 0, hitY = 0, hitZ = 0, hit = false;
      for (let step = 0; step < 128; step++) {
        const px = eye[0] + dirX * travel, py = eye[1] + dirY * travel, pz = eye[2] + dirZ * travel;
        const distance = distanceAt(px, py, pz);
        if (distance < 0.0015) { hitX = px; hitY = py; hitZ = pz; hit = true; break; }
        travel += Math.min(distance * 0.95, 1);
        if (travel > 40) break;
      }
      if (!hit) continue;
      console.log(`probe lattice around sample ${sample}: hit ${hitX.toFixed(2)},${hitY.toFixed(2)},${hitZ.toFixed(2)}`);
      const levelOrigin = level.origin, spacingL = level.spacing;
      for (let cz = 0; cz < level.gridSize[2]!; cz++) {
        for (let cy = 0; cy < level.gridSize[1]!; cy++) {
          for (let cx = 0; cx < level.gridSize[0]!; cx++) {
            const linear = (cz * level.gridSize[1]! + cy) * level.gridSize[0]! + cx;
            const record = records[linear]!;
            const px = levelOrigin[0]! + cx * spacingL;
            const py = levelOrigin[1]! + cy * spacingL;
            const pz = levelOrigin[2]! + cz * spacingL;
            const distanceToHit = Math.hypot(px - hitX, py - hitY, pz - hitZ);
            if (distanceToHit < 1.2) {
              console.log(`  probe(${cx},${cy},${cz}) pos=(${px.toFixed(2)},${py.toFixed(2)},${pz.toFixed(2)})`
                + ` d=${distanceToHit.toFixed(2)} floor=${(record.occlusionFloor ?? 0).toFixed(3)}`
                + ` irr=${record.irradiance.map(value => value.toFixed(3)).join(",")}`);
            }
          }
        }
      }
    }
  });
});

function sub3(a: readonly [number, number, number],
  b: readonly [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross3(a: readonly [number, number, number],
  b: readonly [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[1], a[0] * b[1] - a[1] * b[0]];
}
function normalize3(value: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 1e-8 ? [value[0] / length, value[1] / length, value[2] / length] : [0, 1, 0];
}
