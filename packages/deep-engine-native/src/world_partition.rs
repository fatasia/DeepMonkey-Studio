//! 世界分区合同的 Native 侧镜像（波次4，开放世界基础栈）。
//! 与 TS `packages/deep-engine/src/rayTracing/worldPartition.ts` 逐语义对齐：
//! 512m 固定单元、负象限确定性映射、相机单元绝对优先、速度前瞻加分、key 字典序全序。

pub const WORLD_CELL_SIZE: f64 = 512.0;
pub const WORLD_CELL_LOD_COUNT: u32 = 4;
const MAX_STREAM_RADIUS: i64 = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WorldCellId {
    pub cx: i64,
    pub cz: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct WorldStreamingInput {
    pub camera_x: f64,
    pub camera_z: f64,
    /// 未单位化的前向方向；零向量视为无方向。
    pub forward_x: f64,
    pub forward_z: f64,
    /// 米/秒。
    pub speed: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorldCellPlanEntry {
    pub cell: WorldCellId,
    /// 越小越先加载（与 TS worldStreamingPriority 同值语义）。
    pub priority: f64,
}

pub fn world_cell_center(id: WorldCellId) -> (f64, f64) {
    (
        (id.cx as f64 + 0.5) * WORLD_CELL_SIZE,
        (id.cz as f64 + 0.5) * WORLD_CELL_SIZE,
    )
}

pub fn world_cell_of(x: f64, z: f64) -> Result<WorldCellId, String> {
    if !x.is_finite() || !z.is_finite() {
        return Err("World position must be finite.".to_string());
    }
    Ok(WorldCellId {
        cx: (x / WORLD_CELL_SIZE).floor() as i64,
        cz: (z / WORLD_CELL_SIZE).floor() as i64,
    })
}

pub fn world_cell_key(id: WorldCellId) -> String {
    format!("{}|{}", id.cx, id.cz)
}

pub fn world_streaming_priority(id: WorldCellId, input: &WorldStreamingInput) -> f64 {
    let camera_cell =
        world_cell_of(input.camera_x, input.camera_z).expect("camera position validated by caller");
    if camera_cell.cx == id.cx && camera_cell.cz == id.cz {
        return f64::NEG_INFINITY;
    }
    let (center_x, center_z) = world_cell_center(id);
    let dx = center_x - input.camera_x;
    let dz = center_z - input.camera_z;
    let distance = (dx * dx + dz * dz).sqrt();
    let forward_length =
        (input.forward_x * input.forward_x + input.forward_z * input.forward_z).sqrt();
    let projection = if forward_length > 0.0 && input.speed > 0.0 {
        (dx * input.forward_x + dz * input.forward_z) / (forward_length * distance.max(1.0))
    } else {
        0.0
    };
    let in_front = if forward_length > 0.0 && dx * input.forward_x + dz * input.forward_z > 0.0 {
        0.0
    } else {
        64.0
    };
    distance + input.speed * 2.0 * projection.max(0.0) + in_front
}

/// 环形请求集：相机单元 ± radius，优先级升序、key 兜底字典序（与 TS 全序一致）。
pub fn world_streaming_plan(
    input: &WorldStreamingInput,
    radius: i64,
) -> Result<Vec<WorldCellPlanEntry>, String> {
    if !(0..=MAX_STREAM_RADIUS).contains(&radius) {
        return Err(format!(
            "Streaming radius must be an integer in [0,{MAX_STREAM_RADIUS}]."
        ));
    }
    let center = world_cell_of(input.camera_x, input.camera_z)?;
    let mut cells: Vec<WorldCellPlanEntry> = Vec::new();
    for dz in -radius..=radius {
        for dx in -radius..=radius {
            let cell = WorldCellId {
                cx: center.cx + dx,
                cz: center.cz + dz,
            };
            cells.push(WorldCellPlanEntry {
                cell,
                priority: world_streaming_priority(cell, input),
            });
        }
    }
    cells.sort_by(|a, b| {
        a.priority
            .partial_cmp(&b.priority)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| world_cell_key(a.cell).cmp(&world_cell_key(b.cell)))
    });
    Ok(cells)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stationary() -> WorldStreamingInput {
        WorldStreamingInput {
            camera_x: 0.0,
            camera_z: 0.0,
            forward_x: 0.0,
            forward_z: 0.0,
            speed: 0.0,
        }
    }

    #[test]
    fn maps_positions_deterministically_across_negative_quadrants() {
        assert_eq!(
            world_cell_of(100.0, -100.0).unwrap(),
            WorldCellId { cx: 0, cz: -1 }
        );
        assert_eq!(
            world_cell_of(-1.0, -1.0).unwrap(),
            WorldCellId { cx: -1, cz: -1 }
        );
        assert!(world_cell_of(f64::NAN, 0.0).is_err());
        assert_eq!(world_cell_key(WorldCellId { cx: -3, cz: 7 }), "-3|7");
    }

    #[test]
    fn ranks_camera_cell_first_and_matches_ts_plan_shape() {
        let input = WorldStreamingInput {
            camera_x: 900.0,
            camera_z: -700.0,
            forward_x: 1.0,
            forward_z: 0.0,
            speed: 30.0,
        };
        let plan = world_streaming_plan(&input, 2).unwrap();
        assert_eq!(plan.len(), 25);
        assert_eq!(plan[0].cell, world_cell_of(900.0, -700.0).unwrap());
    }

    #[test]
    fn prefers_cells_along_velocity_for_a_moving_camera() {
        let moving = WorldStreamingInput {
            camera_x: 256.0,
            camera_z: 256.0,
            forward_x: 1.0,
            forward_z: 0.0,
            speed: 20.0,
        };
        let ahead = world_streaming_priority(WorldCellId { cx: 2, cz: 0 }, &moving);
        let behind = world_streaming_priority(WorldCellId { cx: -2, cz: 0 }, &moving);
        assert!(ahead < behind);
    }

    #[test]
    fn validates_radius_fail_closed() {
        let input = stationary();
        assert!(world_streaming_plan(&input, -1).is_err());
        assert!(world_streaming_plan(&input, 65).is_err());
    }
}
