//! 世界分区 → chunk 流送需求桥的 Native 镜像（波次4）。
//! 与 TS `rayTracing/worldChunkBridge.ts` 逐语义对齐：`world|cx|cz|lodN` 键空间与
//! 作者场景 chunk 键永不冲突；maxCells/maxLod 有界；解析 fail-closed。

use crate::world_partition::{
    WORLD_CELL_LOD_COUNT, WorldCellId, WorldStreamingInput, world_streaming_plan,
};

pub const DEFAULT_MAX_CELLS: u32 = 64;

#[derive(Debug, Clone, PartialEq)]
pub struct WorldChunkDemand {
    pub key: String,
    pub cell: WorldCellId,
    pub lod: u32,
    pub center: (f64, f64),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WorldChunkBridgeOptions {
    pub max_cells: u32,
    /// 期望集中保留的 LOD 层数（1..=WORLD_CELL_LOD_COUNT）。
    pub max_lod: u32,
}

pub fn world_chunk_key(cell: WorldCellId, lod: u32) -> String {
    format!("world|{}|{}|lod{}", cell.cx, cell.cz, lod)
}

/// 键解析：非 `world|` 前缀（作者 chunk 键）或 lod 越界返回 None。
pub fn parse_world_chunk_key(key: &str) -> Option<(WorldCellId, u32)> {
    let parts: Vec<&str> = key.split('|').collect();
    if parts.len() != 4 || parts[0] != "world" {
        return None;
    }
    let cx = parts[1].parse::<i64>().ok()?;
    let cz = parts[2].parse::<i64>().ok()?;
    let lod = parts[3].strip_prefix("lod")?.parse::<u32>().ok()?;
    if lod >= WORLD_CELL_LOD_COUNT {
        return None;
    }
    Some((WorldCellId { cx, cz }, lod))
}

/// 相机流送输入 → lod 键控 chunk 期望集（与 TS planWorldChunkDemand 同序同界）。
pub fn plan_world_chunk_demand(
    input: &WorldStreamingInput,
    radius: i64,
    options: WorldChunkBridgeOptions,
) -> Result<Vec<WorldChunkDemand>, String> {
    if options.max_cells == 0 {
        return Err("maxCells must be a positive integer.".to_string());
    }
    if options.max_lod == 0 || options.max_lod > WORLD_CELL_LOD_COUNT {
        return Err(format!(
            "maxLod must be an integer in [1,{WORLD_CELL_LOD_COUNT}]."
        ));
    }
    let plan = world_streaming_plan(input, radius)?;
    let mut demands =
        Vec::with_capacity(plan.len().min(options.max_cells as usize) * options.max_lod as usize);
    for entry in plan.into_iter().take(options.max_cells as usize) {
        let center = crate::world_partition::world_cell_center(entry.cell);
        for lod in 0..options.max_lod {
            demands.push(WorldChunkDemand {
                key: world_chunk_key(entry.cell, lod),
                cell: entry.cell,
                lod,
                center,
            });
        }
    }
    Ok(demands)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_cells_into_lod_keyed_demands_with_bounds() {
        let input = WorldStreamingInput {
            camera_x: 900.0,
            camera_z: -700.0,
            forward_x: 1.0,
            forward_z: 0.0,
            speed: 10.0,
        };
        let demands = plan_world_chunk_demand(
            &input,
            1,
            WorldChunkBridgeOptions {
                max_cells: 9,
                max_lod: 2,
            },
        )
        .unwrap();
        assert_eq!(demands.len(), 18);
        assert!(demands.iter().all(|demand| demand.lod < 2));
        let unique: std::collections::HashSet<_> =
            demands.iter().map(|demand| demand.key.clone()).collect();
        assert_eq!(unique.len(), 18);
    }

    #[test]
    fn round_trips_keys_and_rejects_author_keys() {
        let key = world_chunk_key(WorldCellId { cx: -3, cz: 12 }, 2);
        assert_eq!(
            parse_world_chunk_key(&key),
            Some((WorldCellId { cx: -3, cz: 12 }, 2))
        );
        assert_eq!(parse_world_chunk_key("some-scene-geometry|deep-vg-0"), None);
        assert_eq!(parse_world_chunk_key("world|1|2|lod9"), None);
        assert_eq!(parse_world_chunk_key("world|1|2|core"), None);
    }

    #[test]
    fn validates_options_fail_closed() {
        let input = WorldStreamingInput {
            camera_x: 0.0,
            camera_z: 0.0,
            forward_x: 0.0,
            forward_z: 0.0,
            speed: 0.0,
        };
        assert!(
            plan_world_chunk_demand(
                &input,
                1,
                WorldChunkBridgeOptions {
                    max_cells: 0,
                    max_lod: 1
                }
            )
            .is_err()
        );
        assert!(
            plan_world_chunk_demand(
                &input,
                1,
                WorldChunkBridgeOptions {
                    max_cells: 4,
                    max_lod: 5
                }
            )
            .is_err()
        );
    }
}
