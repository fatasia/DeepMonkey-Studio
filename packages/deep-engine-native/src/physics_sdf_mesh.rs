//! F6:SDF 体素场 → 凹体碰撞网格(Freudenthal 六四面体提取,Rust 镜像)。
//!
//! 与 Web `packages/deep-engine/src/physics/sdfCollisionBridge.ts` 算法逐位同构:
//! 同一 16-mask 棱环序表、同一棱去重键(min·2²¹+max)、同一 f32 插值链
//! `t = d_a/(d_a−d_b)`,`p = p_a + t·(p_b−p_a)`。输入 distances 逐位相同
//! (JSON f32 十进制最短表示往返无损)时,两端提取的顶点/索引缓冲逐位相同,
//! 由 `physics_sdf_l_fixture.json`(TS 侧生成)以 SHA-256 对拍为证。
//!
//! 边界语义与 TS 一致:域边缘一圈按最近内点常值外推(外推区不产生等值面,
//! 源几何必须与网格边界保持 ≥1 cell 间距)。

use std::collections::HashMap;

/// Freudenthal/Kuhn 主对角剖分:每 cell 同表(体对角线 0-6 的六个置换四面体)。
/// 跨 cell 面对角线天然一致(x 面 0-7/1-6、y 面 0-5/3-6、z 面 0-2/4-6),
/// 闭合场输出闭合流形(TS 侧以逐棱恰好两三角形证明,本侧同样测试)。
const KUHN_TETS: [[usize; 4]; 6] = [
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
    [0, 4, 5, 6],
    [0, 5, 1, 6],
];

/// 立方体 8 角点本地偏移(编码 = x | y<<1 | z<<2,与 TS CUBE_CORNERS 一致)。
const CUBE_CORNERS: [[usize; 3]; 8] = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
];

/// tet 本地棱编号(TET_EDGES 下标)。
const E01: usize = 0;
const E02: usize = 1;
const E03: usize = 2;
const E12: usize = 3;
const E13: usize = 4;
const E23: usize = 5;

const TET_EDGES: [[usize; 2]; 6] = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

/// 16 mask → 等值面棱环序(mask 位 i = 顶点 i 在内部,d<0);None = 0/15 全外/全内。
/// 三角形情形只填 3 条棱(第 4 位重复占位);两顶点在内部的 6 个 mask 按真实
/// 等值线段环序给出四条棱,拆分固定 (0,1,2)+(0,2,3),每条线段恰配对一次。
const MASK_POLYGONS: [Option<[usize; 4]>; 16] = [
    None,
    Some([E01, E02, E03, E03]),
    Some([E01, E12, E13, E13]),
    Some([E02, E03, E13, E12]),
    Some([E02, E12, E23, E23]),
    Some([E01, E03, E23, E12]),
    Some([E01, E02, E23, E13]),
    Some([E03, E13, E23, E23]),
    Some([E03, E23, E13, E13]),
    Some([E01, E02, E23, E13]),
    Some([E01, E03, E23, E12]),
    Some([E02, E12, E23, E23]),
    Some([E02, E03, E13, E12]),
    Some([E01, E12, E13, E13]),
    Some([E01, E02, E03, E03]),
    None,
];

/// 与 sdfGrid 的 MAX_CELLS 同源上限(消费方先校验;此处再守一道)。
pub const MAX_SDF_MESH_CELLS: usize = 262_144;

/// 提取预算:与运行包 MAX_COLLIDER_INDICES/3 对齐,超限 fail-closed。
pub const MAX_SDF_COLLISION_TRIANGLES: usize = 65_536;

/// 提取输入:有界 SDF 体素场(距离单位米,负 = 内部)。
pub struct SdfMeshInput<'a> {
    pub origin: [f32; 3],
    pub cell_size: f32,
    pub dimensions: [usize; 3],
    /// 长度必须等于 dimensions 体积,(z·ny+y)·nx+x 线性序。
    pub distances: &'a [f32],
}

/// 提取输出:trimesh 顶点(xyz 交叠)与三角形索引,可直接喂
/// `ColliderBuilder::trimesh`。坐标系 = 刚体局部空间(与运行包语义一致)。
#[derive(Debug)]
pub struct SdfCollisionMesh {
    pub positions: Vec<f32>,
    pub indices: Vec<u32>,
    pub triangle_count: usize,
    pub vertex_count: usize,
}

/// 确定性提取零等值面。预算超限/非法输入返回 Err(文案与 TS 镜像,测试可断言)。
pub fn extract_sdf_collision_mesh(grid: &SdfMeshInput) -> Result<SdfCollisionMesh, String> {
    let [nx, ny, nz] = grid.dimensions;
    let cells = nx * ny * nz;
    if nx < 2
        || ny < 2
        || nz < 2
        || nx > 128
        || ny > 128
        || nz > 128
        || cells > MAX_SDF_MESH_CELLS
        || grid.distances.len() != cells
    {
        return Err(format!(
            "SDF 碰撞提取要求有界网格(每维 2..128、cells ≤ {MAX_SDF_MESH_CELLS}),实测 {nx}×{ny}×{nz}"
        ));
    }
    if !grid.cell_size.is_finite()
        || grid.cell_size <= 0.0
        || grid.origin.iter().any(|v| !v.is_finite())
    {
        return Err("SDF 碰撞提取要求有限正 cellSize 与有限 origin".into());
    }
    if grid.distances.iter().any(|value| !value.is_finite()) {
        return Err("SDF 碰撞提取拒绝非有限距离值".into());
    }

    let stride_y = nx + 1;
    let stride_z = (ny + 1) * stride_y;
    let point_count = stride_z * (nz + 1);
    let mut px = vec![0f32; point_count];
    let mut py = vec![0f32; point_count];
    let mut pz = vec![0f32; point_count];
    let mut pd = vec![0f32; point_count];
    for z in 0..=nz {
        for y in 0..=ny {
            for x in 0..=nx {
                let point = z * stride_z + y * stride_y + x;
                // f64 求值后收敛 f32,与 TS `Math.fround(ox + x*cs)` 逐位一致。
                px[point] = (f64::from(grid.origin[0])
                    + f64::from(x as f32) * f64::from(grid.cell_size))
                    as f32;
                py[point] = (f64::from(grid.origin[1])
                    + f64::from(y as f32) * f64::from(grid.cell_size))
                    as f32;
                pz[point] = (f64::from(grid.origin[2])
                    + f64::from(z as f32) * f64::from(grid.cell_size))
                    as f32;
                pd[point] = if x < nx && y < ny && z < nz {
                    grid.distances[z * ny * nx + y * nx + x]
                } else {
                    grid.distances[z.min(nz - 1) * ny * nx + y.min(ny - 1) * nx + x.min(nx - 1)]
                };
            }
        }
    }

    let mut positions: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    let mut edge_vertices: HashMap<usize, u32> = HashMap::new();

    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let base = z * stride_z + y * stride_y + x;
                let cube_d: [f32; 8] = std::array::from_fn(|corner| {
                    let [dx, dy, dz] = CUBE_CORNERS[corner];
                    pd[base + dz * stride_z + dy * stride_y + dx]
                });
                for tet in &KUHN_TETS {
                    let d: [f32; 4] = [
                        cube_d[tet[0]],
                        cube_d[tet[1]],
                        cube_d[tet[2]],
                        cube_d[tet[3]],
                    ];
                    let mut mask = 0usize;
                    for (i, value) in d.iter().enumerate() {
                        if *value < 0.0 {
                            mask |= 1 << i;
                        }
                    }
                    let Some(polygon) = MASK_POLYGONS[mask] else {
                        continue;
                    };
                    let unique_edges = if polygon[2] == polygon[3] { 3 } else { 4 };
                    let mut crossings = [0u32; 4];
                    for slot in 0..unique_edges {
                        let edge = TET_EDGES[polygon[slot]];
                        crossings[slot] = edge_vertex(
                            &mut positions,
                            &mut edge_vertices,
                            base,
                            stride_y,
                            stride_z,
                            tet[edge[0]],
                            tet[edge[1]],
                            cube_d[tet[edge[0]]],
                            cube_d[tet[edge[1]]],
                            &px,
                            &py,
                            &pz,
                        )?;
                    }
                    if indices.len() + if unique_edges == 4 { 6 } else { 3 }
                        > MAX_SDF_COLLISION_TRIANGLES * 3
                    {
                        return Err(format!(
                            "SDF 等值面三角形数将超出预算 {MAX_SDF_COLLISION_TRIANGLES};请降低网格分辨率或提高预算"
                        ));
                    }
                    // 向外定向:trimesh 接触法线取三角形绕向,必须一致朝外(场正侧)。
                    // 方向参考 = 首个外部顶点 − 首个内部顶点(按 tet 顶点序取第一对):
                    // tet 内场线性,任一异侧点对必然横穿零平面,dot 严格非退化
                    // (均值规则在 2-in/2-out 且内外均值同层的 tet 上会退化到面内)。
                    // 坐标差在 f64 域求值,与 TS number 语义逐位一致。
                    let mut first_out: Option<[f64; 3]> = None;
                    let mut first_in: Option<[f64; 3]> = None;
                    for vertex in 0..4 {
                        let [dx, dy, dz] = CUBE_CORNERS[tet[vertex]];
                        let point = base + dz * stride_z + dy * stride_y + dx;
                        let coords = [
                            f64::from(px[point]),
                            f64::from(py[point]),
                            f64::from(pz[point]),
                        ];
                        if cube_d[tet[vertex]] < 0.0 {
                            first_in.get_or_insert(coords);
                        } else {
                            first_out.get_or_insert(coords);
                        }
                    }
                    let out = first_out.expect("tet with a crossing has an outside vertex");
                    let inside = first_in.expect("tet with a crossing has an inside vertex");
                    let reference = [out[0] - inside[0], out[1] - inside[1], out[2] - inside[2]];
                    emit_triangle(&positions, &mut indices, crossings, unique_edges, reference);
                }
            }
        }
    }
    if indices.is_empty() {
        return Err("SDF 网格不含零等值面(全场同号);凹体碰撞要求正负距离并存".into());
    }
    Ok(SdfCollisionMesh {
        vertex_count: positions.len() / 3,
        triangle_count: indices.len() / 3,
        positions,
        indices,
    })
}

/// 棱交点顶点(共享棱去重):键 = min·2²¹ + max(衬垫线性点索引 < 2²¹),
/// 插值 `t = d_a/(d_a−d_b)`、`p = p_a + t·(p_b−p_a)` 全 f32,与 TS 逐位一致。
#[allow(clippy::too_many_arguments)]
fn edge_vertex(
    positions: &mut Vec<f32>,
    edge_vertices: &mut HashMap<usize, u32>,
    base: usize,
    stride_y: usize,
    stride_z: usize,
    corner_a: usize,
    corner_b: usize,
    da: f32,
    db: f32,
    px: &[f32],
    py: &[f32],
    pz: &[f32],
) -> Result<u32, String> {
    let [ax, ay, az] = CUBE_CORNERS[corner_a];
    let [bx, by, bz] = CUBE_CORNERS[corner_b];
    let point_a = base + az * stride_z + ay * stride_y + ax;
    let point_b = base + bz * stride_z + by * stride_y + bx;
    let key = point_a.min(point_b) * 2_097_152 + point_a.max(point_b);
    if let Some(cached) = edge_vertices.get(&key) {
        return Ok(*cached);
    }
    let index = u32::try_from(positions.len() / 3)
        .map_err(|_| "SDF 等值面顶点数超出 u32 索引域".to_string())?;
    let t = da / (da - db);
    for axis_positions in [px, py, pz] {
        positions.push(
            axis_positions[point_a] + t * (axis_positions[point_b] - axis_positions[point_a]),
        );
    }
    edge_vertices.insert(key, index);
    Ok(index)
}

/// 三角形外向定向:n = (b−a)×(c−a);dot(n, 参考−a) < 0 时交换 (b,c)。
/// 参考点 = tet 外部顶点质心(场正侧 = 外);方向由场符号全局一致传递,
/// 整面 winding 一致。符号判定在 f64 域求值(位置本身是 f32 值,f64 运算
/// 与 TS number 语义逐位一致);输出仅索引顺序受影响。
fn emit_triangle(
    positions: &[f32],
    indices: &mut Vec<u32>,
    crossings: [u32; 4],
    unique_edges: usize,
    reference: [f64; 3],
) {
    let emit = |indices: &mut Vec<u32>, a: u32, b: u32, c: u32| {
        let at = a as usize * 3;
        let (ax, ay, az) = (
            f64::from(positions[at]),
            f64::from(positions[at + 1]),
            f64::from(positions[at + 2]),
        );
        let bt = b as usize * 3;
        let e1 = [
            f64::from(positions[bt]) - ax,
            f64::from(positions[bt + 1]) - ay,
            f64::from(positions[bt + 2]) - az,
        ];
        let ct = c as usize * 3;
        let e2 = [
            f64::from(positions[ct]) - ax,
            f64::from(positions[ct + 1]) - ay,
            f64::from(positions[ct + 2]) - az,
        ];
        let normal = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        let dot = normal[0] * (reference[0] - ax)
            + normal[1] * (reference[1] - ay)
            + normal[2] * (reference[2] - az);
        if dot < 0.0 {
            indices.extend_from_slice(&[a, c, b]);
        } else {
            indices.extend_from_slice(&[a, b, c]);
        }
    };
    emit(indices, crossings[0], crossings[1], crossings[2]);
    if unique_edges == 4 {
        emit(indices, crossings[0], crossings[2], crossings[3]);
    }
}

#[cfg(test)]
mod tests {
    use super::{SdfCollisionMesh, SdfMeshInput, extract_sdf_collision_mesh};
    use std::collections::HashMap;

    /// 与 TS fixture 同源凹 L 棱柱解析 SDF:x∈[0,1]×y∈[0,3] ∪ x∈[0,3]×y∈[0,1],
    /// z∈[0,1],全 f32 运算(仅作本模块测试夹具;跨端对拍用真实 fixture)。
    fn l_prism_distance(x: f32, y: f32, z: f32) -> f32 {
        let rect = |cx: f32, cy: f32, hx: f32, hy: f32| {
            let dx = (x - cx).abs() - hx;
            let dy = (y - cy).abs() - hy;
            let outside_x = dx.max(0.0);
            let outside_y = dy.max(0.0);
            (outside_x * outside_x + outside_y * outside_y).sqrt() + dx.max(dy).min(0.0)
        };
        let xy = rect(0.5, 1.5, 0.5, 1.5).min(rect(1.5, 0.5, 1.5, 0.5));
        let dz = (z - 0.5).abs() - 0.5;
        let outside_z = dz.max(0.0);
        xy.max(0.0).hypot(outside_z) + xy.max(dz).min(0.0)
    }

    fn l_grid() -> SdfMeshInput<'static> {
        let origin = [-0.125f32, -0.125, -0.125];
        let (nx, ny, nz) = (16usize, 16usize, 8usize);
        let cell = 0.25f32;
        let mut distances = Vec::with_capacity(nx * ny * nz);
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let px = origin[0] + x as f32 * cell;
                    let py = origin[1] + y as f32 * cell;
                    let pz = origin[2] + z as f32 * cell;
                    distances.push(l_prism_distance(px, py, pz));
                }
            }
        }
        SdfMeshInput {
            origin,
            cell_size: cell,
            dimensions: [nx, ny, nz],
            distances: Box::leak(distances.into_boxed_slice()),
        }
    }

    fn edge_use(mesh: &SdfCollisionMesh) -> HashMap<(u32, u32), usize> {
        let mut use_count: HashMap<(u32, u32), usize> = HashMap::new();
        for tri in mesh.indices.chunks_exact(3) {
            for corner in 0..3 {
                let a = tri[corner];
                let b = tri[(corner + 1) % 3];
                *use_count.entry((a.min(b), a.max(b))).or_default() += 1;
            }
        }
        use_count
    }

    #[test]
    fn concave_l_surface_is_closed_and_deterministic() {
        let first = extract_sdf_collision_mesh(&l_grid()).expect("extraction succeeds");
        assert!(
            first.triangle_count > 100,
            "triangle count {}",
            first.triangle_count
        );
        for (edge, count) in edge_use(&first) {
            assert_eq!(count, 2, "edge {edge:?} used {count} times");
        }
        let second = extract_sdf_collision_mesh(&l_grid()).expect("repeat succeeds");
        assert_eq!(second.positions, first.positions);
        assert_eq!(second.indices, first.indices);
    }

    #[test]
    fn payload_violations_fail_closed() {
        let grid = l_grid();
        let flat = SdfMeshInput {
            origin: grid.origin,
            cell_size: grid.cell_size,
            dimensions: grid.dimensions,
            distances: Box::leak(vec![1.0f32; 16 * 16 * 8].into_boxed_slice()),
        };
        assert!(
            extract_sdf_collision_mesh(&flat)
                .unwrap_err()
                .contains("全场同号")
        );
        let bad_dims = SdfMeshInput {
            origin: grid.origin,
            cell_size: grid.cell_size,
            dimensions: [1, 16, 8],
            distances: Box::leak(vec![0.0f32; 16 * 8].into_boxed_slice()),
        };
        assert!(
            extract_sdf_collision_mesh(&bad_dims)
                .unwrap_err()
                .contains("有界网格")
        );
        let mut nan_distances = grid.distances.to_vec();
        nan_distances[0] = f32::NAN;
        let nan_grid = SdfMeshInput {
            origin: grid.origin,
            cell_size: grid.cell_size,
            dimensions: grid.dimensions,
            distances: Box::leak(nan_distances.into_boxed_slice()),
        };
        assert!(
            extract_sdf_collision_mesh(&nan_grid)
                .unwrap_err()
                .contains("非有限")
        );
    }

    /// 跨端逐位对拍:TS(vitest,buildSdfGrid × concavePrism)生成
    /// `physics_sdf_l_fixture.json`(distances + 提取 SHA-256),本侧以同字节
    /// distances 提取并比对。小端序主机(x86-64/AArch64)上 f32/u32 字节序一致。
    #[test]
    fn matches_web_fixture_bitwise() {
        let fixture_text = include_str!("physics_sdf_l_fixture.json");
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fixture {
            meta: serde_json::Value,
            distances: Vec<f64>,
            expect: FixtureExpect,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct FixtureExpect {
            triangle_count: usize,
            vertex_count: usize,
            positions_sha256: String,
            indices_sha256: String,
        }
        let fixture: Fixture = serde_json::from_str(fixture_text).expect("fixture parses");
        let meta = &fixture.meta["grid"];
        let origin: [f64; 3] = serde_json::from_value(meta["origin"].clone()).unwrap();
        let cell_size = meta["cellSize"].as_f64().unwrap();
        let dimensions: [u64; 3] = serde_json::from_value(meta["dimensions"].clone()).unwrap();
        let distances: Vec<f32> = fixture
            .distances
            .iter()
            .map(|value| *value as f32)
            .collect();
        let mesh = extract_sdf_collision_mesh(&SdfMeshInput {
            origin: [origin[0] as f32, origin[1] as f32, origin[2] as f32],
            cell_size: cell_size as f32,
            dimensions: [
                dimensions[0] as usize,
                dimensions[1] as usize,
                dimensions[2] as usize,
            ],
            distances: &distances,
        })
        .expect("fixture grid extracts");
        assert_eq!(mesh.triangle_count, fixture.expect.triangle_count);
        assert_eq!(mesh.vertex_count, fixture.expect.vertex_count);
        let positions_bytes: Vec<u8> = mesh
            .positions
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        let indices_bytes: Vec<u8> = mesh
            .indices
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        assert_eq!(
            crate::shader_package::hash::sha256(&positions_bytes),
            fixture.expect.positions_sha256,
            "positions must match the web extraction bit-for-bit (little-endian f32)"
        );
        assert_eq!(
            crate::shader_package::hash::sha256(&indices_bytes),
            fixture.expect.indices_sha256,
            "indices must match the web extraction bit-for-bit (little-endian u32)"
        );
    }
}
