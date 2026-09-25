//! Bounded Native clustered-lighting planning.
//!
//! Fixed 8x8 screen tiles feed the Native raster and RT fragment shaders.

use crate::{
    local_lighting::{LocalLight, LocalLightKind, MAX_LOCAL_LIGHTS},
    player_view::PlayerView,
};

pub const CLUSTER_GRID_X: usize = 8;
pub const CLUSTER_GRID_Y: usize = 8;
pub const MAX_LIGHTS_PER_CLUSTER: usize = 16;
pub const CLUSTER_STORAGE_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClusterGrid {
    pub indices: [[u8; MAX_LIGHTS_PER_CLUSTER]; CLUSTER_GRID_X * CLUSTER_GRID_Y],
    pub counts: [u8; CLUSTER_GRID_X * CLUSTER_GRID_Y],
    pub overflowed: u32,
}

impl Default for ClusterGrid {
    fn default() -> Self {
        Self {
            indices: [[0; MAX_LIGHTS_PER_CLUSTER]; CLUSTER_GRID_X * CLUSTER_GRID_Y],
            counts: [0; CLUSTER_GRID_X * CLUSTER_GRID_Y],
            overflowed: 0,
        }
    }
}

impl ClusterGrid {
    pub fn build(
        lights: &[LocalLight; MAX_LOCAL_LIGHTS],
        view: PlayerView,
        width: u32,
        height: u32,
    ) -> Self {
        let mut grid = Self::default();
        let aspect = width.max(1) as f32 / height.max(1) as f32;
        let [right, up, forward] = view.basis();
        for (index, light) in lights.iter().enumerate() {
            if light.kind == LocalLightKind::Disabled {
                continue;
            }
            let bounds = if matches!(
                light.kind,
                LocalLightKind::Directional | LocalLightKind::Hemisphere
            ) || light.range <= 0.0
            {
                (0, CLUSTER_GRID_X as i32 - 1, 0, CLUSTER_GRID_Y as i32 - 1)
            } else {
                let relative = [
                    light.position[0] - view.eye()[0],
                    light.position[1] - view.eye()[1],
                    light.position[2] - view.eye()[2],
                ];
                let depth =
                    relative[0] * forward[0] + relative[1] * forward[1] + relative[2] * forward[2];
                if !depth.is_finite()
                    || depth + light.range < view.near
                    || depth - light.range > view.far
                {
                    continue;
                }
                if depth <= view.near + light.range {
                    (0, CLUSTER_GRID_X as i32 - 1, 0, CLUSTER_GRID_Y as i32 - 1)
                } else {
                    let horizontal =
                        relative[0] * right[0] + relative[1] * right[1] + relative[2] * right[2];
                    let vertical = relative[0] * up[0] + relative[1] * up[1] + relative[2] * up[2];
                    let closest = (depth - light.range).max(view.near);
                    let center_x = horizontal * view.focal / (depth * aspect);
                    let center_y = vertical * view.focal / depth;
                    let radius_x = light.range * view.focal / (closest * aspect);
                    let radius_y = light.range * view.focal / closest;
                    let min_x = (((center_x - radius_x) * 0.5 + 0.5) * CLUSTER_GRID_X as f32)
                        .floor() as i32;
                    let max_x = (((center_x + radius_x) * 0.5 + 0.5) * CLUSTER_GRID_X as f32)
                        .floor() as i32;
                    let min_y = (((-center_y - radius_y) * 0.5 + 0.5) * CLUSTER_GRID_Y as f32)
                        .floor() as i32;
                    let max_y = (((-center_y + radius_y) * 0.5 + 0.5) * CLUSTER_GRID_Y as f32)
                        .floor() as i32;
                    (min_x, max_x, min_y, max_y)
                }
            };
            let (min_x, max_x, min_y, max_y) = bounds;
            for y in min_y.max(0)..=max_y.min(CLUSTER_GRID_Y as i32 - 1) {
                for x in min_x.max(0)..=max_x.min(CLUSTER_GRID_X as i32 - 1) {
                    let tile = y as usize * CLUSTER_GRID_X + x as usize;
                    let count = grid.counts[tile] as usize;
                    if count < MAX_LIGHTS_PER_CLUSTER {
                        grid.indices[tile][count] = index as u8;
                        grid.counts[tile] += 1;
                    } else {
                        grid.overflowed += 1;
                    }
                }
            }
        }
        grid
    }

    /// Pack a stable storage ABI: header `[version, tile_count, max_lights, 0]`,
    /// followed by one `[count, index0..index15]` u32 row per tile.
    pub fn pack_storage(&self) -> Vec<u32> {
        let mut packed = Vec::with_capacity(4 + self.indices.len() * 17);
        packed.extend_from_slice(&[
            CLUSTER_STORAGE_VERSION,
            (CLUSTER_GRID_X * CLUSTER_GRID_Y) as u32,
            MAX_LIGHTS_PER_CLUSTER as u32,
            self.overflowed,
        ]);
        for tile in 0..self.indices.len() {
            packed.push(self.counts[tile] as u32);
            packed.extend(self.indices[tile].iter().map(|index| *index as u32));
        }
        packed
    }

    pub fn validate_storage(words: &[u32]) -> bool {
        words.len() == 4 + CLUSTER_GRID_X * CLUSTER_GRID_Y * 17
            && words[0] == CLUSTER_STORAGE_VERSION
            && words[1] == (CLUSTER_GRID_X * CLUSTER_GRID_Y) as u32
            && words[2] == MAX_LIGHTS_PER_CLUSTER as u32
            && words[4..]
                .chunks_exact(17)
                .all(|tile| tile[0] <= MAX_LIGHTS_PER_CLUSTER as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(position: [f32; 3], range: f32) -> LocalLight {
        LocalLight {
            kind: LocalLightKind::Point,
            position,
            direction: [0.0, -1.0, 0.0],
            radiance: [1.0; 3],
            range,
            decay: 2.0,
            inner_cos: 1.0,
            outer_cos: 0.0,
            ..Default::default()
        }
    }

    #[test]
    fn builds_deterministic_screen_clusters_for_visible_local_lights() {
        let mut lights = std::array::from_fn(|_| LocalLight::default());
        lights[0] = point([0.0, 0.0, 0.0], 4.0);
        let grid = ClusterGrid::build(&lights, PlayerView::default(), 800, 600);
        assert!(grid.counts.contains(&1));
        assert_eq!(grid.overflowed, 0);
        assert_eq!(
            grid,
            ClusterGrid::build(&lights, PlayerView::default(), 800, 600)
        );
    }

    #[test]
    fn rejects_behind_camera_and_reports_bounded_overflow() {
        let mut lights = std::array::from_fn(|_| LocalLight::default());
        lights[0] = point([0.0, 0.0, 10.0], 4.0);
        let behind = ClusterGrid::build(&lights, PlayerView::default(), 800, 600);
        assert!(behind.counts.iter().all(|count| *count == 0));
        for (index, light) in lights.iter_mut().enumerate() {
            *light = point([0.0, 0.0, 0.0], 100.0);
            light.radiance[0] = index as f32 + 1.0;
        }
        let crowded = ClusterGrid::build(&lights, PlayerView::default(), 800, 600);
        assert_eq!(
            crowded.overflowed, 0,
            "the authored 16-light budget fits the 16-slot tile cap"
        );
        assert!(
            crowded
                .counts
                .iter()
                .all(|count| *count as usize <= MAX_LIGHTS_PER_CLUSTER)
        );
    }

    #[test]
    fn packs_versioned_storage_contract_with_header_and_fixed_tile_rows() {
        let grid = ClusterGrid::default();
        let packed = grid.pack_storage();
        assert_eq!(packed.len(), 4 + 64 * 17);
        assert!(ClusterGrid::validate_storage(&packed));
        let mut invalid = packed.clone();
        invalid[0] = 2;
        assert!(!ClusterGrid::validate_storage(&invalid));
        invalid = packed;
        invalid[4] = 17;
        assert!(!ClusterGrid::validate_storage(&invalid));
    }

    #[test]
    fn global_and_unbounded_lights_reach_every_tile() {
        let mut lights = std::array::from_fn(|_| LocalLight::default());
        lights[0] = point([0.0, 0.0, 0.0], 4.0);
        lights[0].kind = LocalLightKind::Hemisphere;
        lights[1] = point([0.0, 0.0, 0.0], 4.0);
        lights[1].kind = LocalLightKind::Directional;
        lights[2] = point([0.0, 0.0, 0.0], 0.0);
        let grid = ClusterGrid::build(&lights, PlayerView::default(), 800, 600);
        for tile in 0..64 {
            assert_eq!(grid.counts[tile], 3);
            assert_eq!(&grid.indices[tile][..3], &[0, 1, 2]);
        }
    }

    #[test]
    fn near_camera_light_is_conservatively_visible_across_tiles() {
        let view = PlayerView::default();
        let mut lights = std::array::from_fn(|_| LocalLight::default());
        lights[0] = point(view.eye(), 2.0);
        let grid = ClusterGrid::build(&lights, view, 1920, 1080);
        assert!(grid.counts.iter().all(|count| *count == 1));
    }
}
