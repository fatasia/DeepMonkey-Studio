use super::*;
pub(super) fn camera() -> PlayerView {
    PlayerView {
        yaw: 0.4,
        pitch: -0.15,
        focal: CAMERA_FOCAL,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
        ..PlayerView::default()
    }
}

/// 生产相机投影(帧 uniform 前 4 行同式,列主序)。
pub(super) fn view_projection(view: PlayerView, aspect: f32) -> [[f32; 4]; 4] {
    let eye = view.eye();
    let [right, up, forward] = view.basis();
    let depth = view.far / (view.far - view.near);
    let mut projection = [[0.0f32; 4]; 4];
    for axis in 0..3 {
        projection[axis] = [
            view.focal / aspect * right[axis],
            view.focal * up[axis],
            depth * forward[axis],
            forward[axis],
        ];
    }
    projection[3] = std::array::from_fn(|row| {
        -(0..3)
            .map(|axis| projection[axis][row] * eye[axis])
            .sum::<f32>()
    });
    projection[3][2] -= view.near * depth;
    projection
}

/// 视空间点 → 世界点(与 world_to_view 互逆;列 = 基行分量)。
pub(super) fn view_to_world(view: PlayerView, view_point: [f64; 3]) -> [f32; 3] {
    let [r, u, f] = view.basis();
    let rows = [r, u, [-f[0], -f[1], -f[2]]];
    let eye = view.eye();
    std::array::from_fn(|axis| {
        (0..3)
            .map(|k| rows[k][axis] * view_point[k] as f32)
            .sum::<f32>()
            + eye[axis]
    })
}

/// 逐像素射线-斜面求交(view 系;命中域三区:内 = Some(内)、带 = Skip、外 = None)。
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Zone {
    Covered,
    Skip,
    Background,
}

pub(super) fn plane_hit(
    view: PlayerView,
    aspect: f32,
    px: u32,
    py: u32,
) -> (Zone, Option<[f64; 3]>) {
    let ndc_x = ((f64::from(px) + 0.5) / f64::from(WIDTH)) * 2.0 - 1.0;
    let ndc_y = 1.0 - ((f64::from(py) + 0.5) / f64::from(HEIGHT)) * 2.0;
    // 视空间射线(view z = −depth,相机沿 forward 看):view 坐标方向
    // (x_v, y_v, −1),x_v = ndc_x·aspect/focal,y_v = ndc_y/focal;世界方向 =
    // x_v·right + y_v·up + forward。
    let [right, up, forward] = view.basis();
    let xv = ndc_x * (f64::from(aspect) / f64::from(view.focal));
    let yv = ndc_y / f64::from(view.focal);
    let mut dir = [0.0f64; 3];
    for axis in 0..3 {
        dir[axis] =
            xv * f64::from(right[axis]) + yv * f64::from(up[axis]) + f64::from(forward[axis]);
    }
    let length = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
    for value in &mut dir {
        *value /= length;
    }
    // 斜面(view 系 z = −3 − 0.6x):−f·p = −3 − 0.6·(r·p) 且 p = t·dir →
    // t·(f·dir − 0.6·r·dir) = 3。
    let forward_dot = dir[0] * f64::from(forward[0])
        + dir[1] * f64::from(forward[1])
        + dir[2] * f64::from(forward[2]);
    let right_dot =
        dir[0] * f64::from(right[0]) + dir[1] * f64::from(right[1]) + dir[2] * f64::from(right[2]);
    let denominator = forward_dot - PLANE_SLOPE * right_dot;
    if denominator <= 1e-6 {
        return (Zone::Background, None);
    }
    let t = 3.0 / denominator;
    let up_dot = dir[0] * f64::from(up[0]) + dir[1] * f64::from(up[1]) + dir[2] * f64::from(up[2]);
    // 命中点 view 坐标 = t·(各基方向点乘 dir);z = −t·(f·dir)(斜面式自动满足)。
    let hit = [t * right_dot, t * up_dot, -t * forward_dot];
    let (x, y) = (hit[0], hit[1]);
    let inside = PLANE_X.0 <= x && x <= PLANE_X.1 && PLANE_Y.0 <= y && y <= PLANE_Y.1;
    let inset = PLANE_X.0 + EDGE_MARGIN <= x
        && x <= PLANE_X.1 - EDGE_MARGIN
        && PLANE_Y.0 + EDGE_MARGIN <= y
        && y <= PLANE_Y.1 - EDGE_MARGIN;
    let outside_band = PLANE_X.0 - EDGE_MARGIN <= x
        && x <= PLANE_X.1 + EDGE_MARGIN
        && PLANE_Y.0 - EDGE_MARGIN <= y
        && y <= PLANE_Y.1 + EDGE_MARGIN;
    let zone = if inside && inset {
        Zone::Covered
    } else if inside || outside_band {
        Zone::Skip
    } else {
        Zone::Background
    };
    (zone, inside.then_some(hit))
}

/// NDC 深度(view 点 → 生产投影;镜像与 GPU 光栅化同一定义)。
pub(super) fn ndc_depth(projection: &[[f32; 4]; 4], view: PlayerView, view_point: [f64; 3]) -> f32 {
    let world = view_to_world(view, view_point);
    let mut clip = [0.0f64; 4];
    for row in 0..4 {
        clip[row] = (0..3)
            .map(|col| f64::from(projection[col][row]) * f64::from(world[col]))
            .sum::<f64>()
            + f64::from(projection[3][row]);
    }
    (clip[2] / clip[3]) as f32
}

/// 重建核的 CPU f64 镜像(与 WGSL 逐式同构:深度门 0.1、右/下差分法线、
/// 中性材质、布局 [pos,metallic]/[normal,roughness]/[baseColor,-])。
pub(super) fn reference_surfaces(depth: &[f32], combined: &[[f32; 4]; 4]) -> Vec<MegaSurfaceRow> {
    let rebuild = |px: u32, py: u32, depth_sample: f64| -> [f64; 4] {
        let uv_x = ((f64::from(px) + 0.5) / f64::from(WIDTH)) * 2.0 - 1.0;
        let uv_y = 1.0 - ((f64::from(py) + 0.5) / f64::from(HEIGHT)) * 2.0;
        let ndc = [uv_x, uv_y, depth_sample, 1.0];
        let mut clipped = [0.0f64; 4];
        for row in 0..4 {
            clipped[row] = (0..4)
                .map(|col| f64::from(combined[col][row]) * ndc[col])
                .sum::<f64>();
        }
        std::array::from_fn(|axis| clipped[axis] / clipped[3])
    };
    let at = |px: u32, py: u32| depth[(py * WIDTH + px) as usize];
    let mut surfaces = vec![[[0.0f64; 4]; 3]; PIXELS];
    for py in 0..HEIGHT {
        for px in 0..WIDTH {
            let center = at(px, py);
            let right = at((px + 1).min(WIDTH - 1), py);
            let down = at(px, (py + 1).min(HEIGHT - 1));
            let max = center.max(right).max(down);
            let min = center.min(right).min(down);
            let discontinuous = max - min > 0.1 * max;
            let base = (py * WIDTH + px) as usize;
            if center >= 1.0 || discontinuous {
                continue;
            }
            let c = rebuild(px, py, f64::from(center));
            let r = rebuild((px + 1).min(WIDTH - 1), py, f64::from(right));
            let d = rebuild(px, (py + 1).min(HEIGHT - 1), f64::from(down));
            let edge_r = [r[0] - c[0], r[1] - c[1], r[2] - c[2]];
            let edge_d = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
            let crossed = [
                edge_r[1] * edge_d[2] - edge_r[2] * edge_d[1],
                edge_r[2] * edge_d[0] - edge_r[0] * edge_d[2],
                edge_r[0] * edge_d[1] - edge_r[1] * edge_d[0],
            ];
            let normal_length =
                (crossed[0] * crossed[0] + crossed[1] * crossed[1] + crossed[2] * crossed[2])
                    .sqrt();
            let view_length = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
            let view = if view_length > 0.0001 {
                [
                    -c[0] / view_length,
                    -c[1] / view_length,
                    -c[2] / view_length,
                ]
            } else {
                [0.0, 0.0, 1.0]
            };
            let mut normal = [0.0f64; 3];
            if normal_length > 0.00000001 {
                normal = [
                    crossed[0] / normal_length,
                    crossed[1] / normal_length,
                    crossed[2] / normal_length,
                ];
                if normal[0] * view[0] + normal[1] * view[1] + normal[2] * view[2] < 0.0 {
                    normal = [-normal[0], -normal[1], -normal[2]];
                }
            }
            surfaces[base] = [
                [c[0], c[1], c[2], 0.0],
                [normal[0], normal[1], normal[2], 0.5],
                [0.8, 0.78, 0.75, 0.0],
            ];
        }
    }
    surfaces
}

/// 黄金灯池(fixture 真载荷;与 lib 探针同源;native 生产链不供 IES → 行号清空)。
pub(super) fn fixture_lights() -> Vec<MegaLight> {
    const FIXTURE: &str =
        include_str!("../../../deep-engine/fixtures/megalights-native-parity-v1.json");
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture parses");
    fixture["inputs"]["lights"]
        .as_array()
        .expect("fixture lights")
        .iter()
        .map(|entry| {
            let kind = match entry["kind"].as_str().expect("kind") {
                "point" => MegaLightKind::Point,
                "spot" => MegaLightKind::Spot,
                "area" => MegaLightKind::AreaRect,
                other => panic!("unknown fixture light kind {other}"),
            };
            let vec3 = |value: &serde_json::Value| -> [f64; 3] {
                std::array::from_fn(|index| value[index].as_f64().expect("vec3"))
            };
            let scalar = |key: &str, fallback: f64| entry[key].as_f64().unwrap_or(fallback);
            MegaLight {
                kind,
                position_view: vec3(&entry["positionView"]),
                range: entry["range"].as_f64().expect("range"),
                color: vec3(&entry["color"]),
                intensity: entry["intensity"].as_f64().expect("intensity"),
                decay: scalar("decay", 2.0),
                direction_view: entry["directionView"]
                    .as_array()
                    .map(|values| -> [f64; 3] {
                        std::array::from_fn(|index| values[index].as_f64().expect("direction"))
                    })
                    .unwrap_or([0.0, 0.0, 1.0]),
                inner_cone_cos: scalar("innerConeCos", 1.0),
                outer_cone_cos: scalar("outerConeCos", -1.0),
                half_extent: [0.0, 0.0],
                two_sided: false,
                ies_spot_index: None,
            }
        })
        .collect()
}
