//! Deterministic multi-agent crowd navigation on a fixed 60 Hz simulation tick.
//!
//! T19 slice 1 scope (deep-engine core plan §T19): compact SoA agent state,
//! temporal batch scheduling, velocity-based local avoidance with an explicit
//! narrow-gate queueing rule, and a fixed-step driver so render FPS cannot
//! change formal event results.
//!
//! Design decisions:
//! - **Determinism first.** All per-agent math is scalar `f32` in fixed order
//!   (agent index, then grid cells row-major, then ascending neighbor index).
//!   No RNG, no wall clock, no parallelism inside a step.
//! - **Fixed-step quantized time protocol.** [`CrowdSimulation::advance_seconds`]
//!   quantizes render frame time to whole 60 Hz ticks (`round(dt * 60)`), so
//!   1/60 s frames produce one tick and 1/30 s frames produce two. Any render
//!   framing that covers the same total time in whole ticks replays the exact
//!   same tick sequence, therefore bit-identical states and event logs.
//!   Sub-tick remainders are intentionally dropped; formal/event-accurate
//!   consumers should drive [`CrowdSimulation::advance_ticks`] directly.
//! - **Avoidance strategy: velocity resolution with explicit queueing** (not
//!   RVO). Each active agent steers toward its goal; neighbors ahead inside a
//!   60° cone shrink the allowed forward speed to zero once the gap drops to
//!   [`CrowdConfig::stop_gap`], producing a standstill queue behind a blocked
//!   leader instead of side-to-side oscillation. Separation is a bounded
//!   repulsion term that only applies inside [`CrowdConfig::separation_radius`],
//!   which is smaller than the queue standoff, so a settled queue has no
//!   residual force and cannot oscillate.
//! - **Temporal batching.** Agents are partitioned into
//!   [`CrowdSimulation::group_count`] index groups; one group re-decides its
//!   velocity per tick in round-robin fashion while the rest integrate their
//!   last velocity. With `batch_size >= count` every agent re-decides every
//!   tick (full quality, used for the 100-agent tier). Decisions always read
//!   pre-step positions (decision phase precedes integration), so batching
//!   never interleaves partial updates.
//! - Walls are axis-aligned rectangles in the XZ plane with radius-inflated
//!   minimum-penetration resolution; the blocked velocity component is clamped
//!   so agents slide along walls instead of sticking or jittering.
//!
//! Not in this slice (remaining §T19 subitems): static triangle navmesh path
//! planning, dynamic obstacle re-update, slope/step-height profiling, and the
//! TS/native cross-boundary consumer wiring.

/// Fixed simulation step rate. All crowd time is measured in whole ticks of
/// this rate; formal events are stamped with the tick they occurred on.
pub const SIM_STEP_HZ: f64 = 60.0;

/// Fixed simulation step length in seconds (`f64` scheduling constant).
pub const SIM_STEP_SECONDS: f64 = 1.0 / SIM_STEP_HZ;

/// Fixed simulation step length used by integration (`f32`).
const SIM_STEP_DT: f32 = SIM_STEP_SECONDS as f32;

/// Axis-aligned wall rectangle in the XZ plane. Agents are resolved against
/// the rectangle inflated by their radius.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AabbWall {
    pub min_x: f32,
    pub min_z: f32,
    pub max_x: f32,
    pub max_z: f32,
}

impl AabbWall {
    pub fn new(min_x: f32, min_z: f32, max_x: f32, max_z: f32) -> Result<Self, String> {
        if !min_x.is_finite() || !min_z.is_finite() || !max_x.is_finite() || !max_z.is_finite() {
            return Err("wall bounds must be finite".into());
        }
        if min_x.partial_cmp(&max_x) != Some(std::cmp::Ordering::Less)
            || min_z.partial_cmp(&max_z) != Some(std::cmp::Ordering::Less)
        {
            return Err("wall bounds must satisfy min < max on both axes".into());
        }
        Ok(Self {
            min_x,
            min_z,
            max_x,
            max_z,
        })
    }
}

/// Tuning parameters of the crowd solver. All values are validated finite and
/// in range by [`CrowdSimulation::new`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CrowdConfig {
    /// Neighbor distance at which bounded separation repulsion applies.
    pub separation_radius: f32,
    /// Desired walk speed cap for agents without an explicit per-agent speed.
    pub max_speed: f32,
    /// Queue standoff: when the gap to the nearest neighbor ahead (surface to
    /// surface) drops below this, forward speed is zeroed (standstill queue).
    pub stop_gap: f32,
    /// Gap band above `stop_gap` over which forward speed ramps linearly.
    pub slowdown_band: f32,
    /// Distance to the goal at which an agent is marked arrived (formal event).
    pub arrival_radius: f32,
    /// Gain of the bounded separation term added to the steering velocity.
    pub separation_gain: f32,
    /// Agents per temporal batch; `>= count` disables batching.
    pub batch_size: u32,
}

impl Default for CrowdConfig {
    fn default() -> Self {
        Self {
            separation_radius: 1.2,
            max_speed: 2.0,
            stop_gap: 0.55,
            slowdown_band: 0.45,
            arrival_radius: 0.5,
            separation_gain: 1.5,
            batch_size: 128,
        }
    }
}

/// Compact structure-of-arrays agent state. Columns are indexed by agent id;
/// iteration order over every column is the agent id order, which is one of
/// the two fixed orders determinism relies on.
#[derive(Clone, Debug, Default)]
pub struct CrowdState {
    pub count: u32,
    pub px: Vec<f32>,
    pub pz: Vec<f32>,
    pub vx: Vec<f32>,
    pub vz: Vec<f32>,
    pub gx: Vec<f32>,
    pub gz: Vec<f32>,
    pub radius: Vec<f32>,
    pub max_speed: Vec<f32>,
    pub arrived: Vec<bool>,
}

impl CrowdState {
    /// Builds SoA columns from parallel spawn lists. All vectors must have the
    /// same length; positions/goals must be finite and radii/speeds finite and
    /// non-negative. Speed defaults to `fallback_speed` when `speeds` is empty.
    pub fn new(
        positions: &[[f32; 2]],
        goals: &[[f32; 2]],
        radius: f32,
        fallback_speed: f32,
        speeds: &[f32],
    ) -> Result<Self, String> {
        if positions.len() != goals.len() {
            return Err("positions and goals must have the same length".into());
        }
        if !speeds.is_empty() && speeds.len() != positions.len() {
            return Err("speeds must be empty or match the agent count".into());
        }
        if !radius.is_finite() || radius <= 0.0 {
            return Err("agent radius must be finite and positive".into());
        }
        if !fallback_speed.is_finite() || fallback_speed < 0.0 {
            return Err("fallback speed must be finite and non-negative".into());
        }
        let count = positions.len() as u32;
        let mut state = Self {
            count,
            px: Vec::with_capacity(positions.len()),
            pz: Vec::with_capacity(positions.len()),
            vx: vec![0.0; positions.len()],
            vz: vec![0.0; positions.len()],
            gx: Vec::with_capacity(goals.len()),
            gz: Vec::with_capacity(goals.len()),
            radius: vec![radius; positions.len()],
            max_speed: Vec::with_capacity(positions.len()),
            arrived: vec![false; positions.len()],
        };
        for (index, pair) in positions.iter().enumerate() {
            let [x, z] = *pair;
            if !x.is_finite() || !z.is_finite() {
                return Err(format!("agent {index} position must be finite"));
            }
            state.px.push(x);
            state.pz.push(z);
        }
        for (index, pair) in goals.iter().enumerate() {
            let [x, z] = *pair;
            if !x.is_finite() || !z.is_finite() {
                return Err(format!("agent {index} goal must be finite"));
            }
            state.gx.push(x);
            state.gz.push(z);
        }
        for index in 0..positions.len() {
            let speed = if speeds.is_empty() {
                fallback_speed
            } else {
                speeds[index]
            };
            if !speed.is_finite() || speed < 0.0 {
                return Err(format!(
                    "agent {index} speed must be finite and non-negative"
                ));
            }
            state.max_speed.push(speed);
        }
        Ok(state)
    }
}

/// Formal crowd events, stamped with the fixed tick they occurred on. These
/// are the "formal event results" that must not change with render FPS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CrowdEvent {
    pub tick: u64,
    pub agent: u32,
    pub kind: CrowdEventKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrowdEventKind {
    Arrived,
}

/// Uniform spatial hash over agent positions. Rebuilt per tick; cell contents
/// are filled in ascending agent index order (the second fixed order
/// determinism relies on). Cell size is always set >= the largest query
/// radius so a 3x3 neighborhood is exhaustive.
#[derive(Clone, Debug)]
struct NeighborGrid {
    cell_size: f32,
    origin_x: f32,
    origin_z: f32,
    dim_x: usize,
    dim_z: usize,
    cells: Vec<Vec<u32>>,
}

const MAX_GRID_DIM: usize = 8192;

impl NeighborGrid {
    fn new() -> Self {
        Self {
            cell_size: 1.0,
            origin_x: 0.0,
            origin_z: 0.0,
            dim_x: 1,
            dim_z: 1,
            cells: vec![Vec::new()],
        }
    }

    fn rebuild(&mut self, state: &CrowdState, cell_size: f32) {
        debug_assert!(cell_size.is_finite() && cell_size > 0.0);
        self.cell_size = cell_size;
        let count = state.count as usize;
        if count == 0 {
            self.origin_x = 0.0;
            self.origin_z = 0.0;
            self.dim_x = 1;
            self.dim_z = 1;
            self.cells.clear();
            self.cells.push(Vec::new());
            return;
        }
        let mut min_x = f32::INFINITY;
        let mut min_z = f32::INFINITY;
        let mut max_x = f32::NEG_INFINITY;
        let mut max_z = f32::NEG_INFINITY;
        for index in 0..count {
            min_x = min_x.min(state.px[index]);
            min_z = min_z.min(state.pz[index]);
            max_x = max_x.max(state.px[index]);
            max_z = max_z.max(state.pz[index]);
        }
        self.origin_x = min_x;
        self.origin_z = min_z;
        self.dim_x = (((max_x - min_x) / cell_size) as usize + 1).clamp(1, MAX_GRID_DIM);
        self.dim_z = (((max_z - min_z) / cell_size) as usize + 1).clamp(1, MAX_GRID_DIM);
        let total = self.dim_x * self.dim_z;
        if self.cells.len() != total {
            self.cells = vec![Vec::new(); total];
        } else {
            for cell in &mut self.cells {
                cell.clear();
            }
        }
        for index in 0..count {
            let (cx, cz) = self.cell_of(state.px[index], state.pz[index]);
            self.cells[cz * self.dim_x + cx].push(index as u32);
        }
    }

    #[inline]
    fn cell_of(&self, x: f32, z: f32) -> (usize, usize) {
        let cx =
            (((x - self.origin_x) / self.cell_size) as isize).clamp(0, self.dim_x as isize - 1);
        let cz =
            (((z - self.origin_z) / self.cell_size) as isize).clamp(0, self.dim_z as isize - 1);
        (cx as usize, cz as usize)
    }

    /// Visits agents within `radius` of `agent` in deterministic order: grid
    /// cells row-major, then ascending agent index inside each cell. Calls
    /// `visit(j, dx, dz, dist)` with `d` = distance between the two agents.
    fn for_each_within<F: FnMut(u32, f32, f32, f32)>(
        &self,
        state: &CrowdState,
        agent: u32,
        radius: f32,
        mut visit: F,
    ) {
        let index = agent as usize;
        let (cx, cz) = self.cell_of(state.px[index], state.pz[index]);
        let radius_sq = radius * radius;
        for dz in -1isize..=1 {
            for dx in -1isize..=1 {
                let nx = cx as isize + dx;
                let nz = cz as isize + dz;
                if nx < 0 || nz < 0 || nx >= self.dim_x as isize || nz >= self.dim_z as isize {
                    continue;
                }
                for &other in &self.cells[nz as usize * self.dim_x + nx as usize] {
                    if other == agent {
                        continue;
                    }
                    let j = other as usize;
                    let ddx = state.px[j] - state.px[index];
                    let ddz = state.pz[j] - state.pz[index];
                    let dist_sq = ddx * ddx + ddz * ddz;
                    if dist_sq <= radius_sq {
                        visit(other, ddx, ddz, dist_sq.sqrt());
                    }
                }
            }
        }
    }
}

/// Fixed-tick crowd simulation: SoA state + temporal batching + velocity
/// avoidance with explicit queueing + inflated-wall resolution.
#[derive(Clone, Debug)]
pub struct CrowdSimulation {
    config: CrowdConfig,
    walls: Vec<AabbWall>,
    state: CrowdState,
    grid: NeighborGrid,
    scratch_cell: f32,
    tick: u64,
    events: Vec<CrowdEvent>,
}

impl CrowdSimulation {
    pub fn new(
        config: CrowdConfig,
        walls: Vec<AabbWall>,
        state: CrowdState,
    ) -> Result<Self, String> {
        if !config.separation_radius.is_finite() || config.separation_radius <= 0.0 {
            return Err("separation_radius must be finite and positive".into());
        }
        if !config.max_speed.is_finite() || config.max_speed < 0.0 {
            return Err("max_speed must be finite and non-negative".into());
        }
        if !config.stop_gap.is_finite() || config.stop_gap < 0.0 {
            return Err("stop_gap must be finite and non-negative".into());
        }
        if !config.slowdown_band.is_finite() || config.slowdown_band <= 0.0 {
            return Err("slowdown_band must be finite and positive".into());
        }
        if !config.arrival_radius.is_finite() || config.arrival_radius <= 0.0 {
            return Err("arrival_radius must be finite and positive".into());
        }
        if !config.separation_gain.is_finite() || config.separation_gain < 0.0 {
            return Err("separation_gain must be finite and non-negative".into());
        }
        if config.batch_size == 0 {
            return Err("batch_size must be at least 1".into());
        }
        let mut max_radius = 0.0f32;
        for index in 0..state.count as usize {
            max_radius = max_radius.max(state.radius[index]);
        }
        Ok(Self {
            config,
            walls,
            state,
            grid: NeighborGrid::new(),
            // Collision queries need cell >= max pairwise radius sum.
            scratch_cell: (2.0 * max_radius).max(1e-3),
            tick: 0,
            events: Vec::new(),
        })
    }

    pub fn state(&self) -> &CrowdState {
        &self.state
    }

    pub fn tick(&self) -> u64 {
        self.tick
    }

    pub fn config(&self) -> &CrowdConfig {
        &self.config
    }

    /// Number of temporal batch groups. `1` means every agent re-decides every
    /// tick (full quality).
    pub fn group_count(&self) -> u32 {
        (self.state.count / self.config.batch_size)
            .saturating_add(u32::from(
                !self.state.count.is_multiple_of(self.config.batch_size),
            ))
            .max(1)
    }

    /// Index group an agent belongs to; group `t % group_count` is active on
    /// tick `t`. Pure and deterministic.
    pub fn schedule_group(&self, agent: u32) -> u32 {
        agent % self.group_count()
    }

    /// Takes the events accumulated so far (tick-ascending, agent-ascending
    /// within a tick).
    pub fn drain_events(&mut self) -> Vec<CrowdEvent> {
        std::mem::take(&mut self.events)
    }

    /// Quantized render-frame driver: converts frame time to whole 60 Hz ticks
    /// (`round(dt * 60)`; 1/60 -> 1 tick, 1/30 -> 2 ticks) and advances that
    /// many fixed steps. Non-positive or non-finite frame times advance
    /// nothing. Returns the number of ticks executed. Sub-tick remainders are
    /// dropped by design; see the module docs for the determinism contract.
    pub fn advance_seconds(&mut self, frame_dt_seconds: f64) -> u32 {
        if !frame_dt_seconds.is_finite() || frame_dt_seconds <= 0.0 {
            return 0;
        }
        let ticks = (frame_dt_seconds * SIM_STEP_HZ).round();
        let ticks = if ticks >= u32::MAX as f64 {
            u32::MAX
        } else {
            ticks.max(0.0) as u32
        };
        self.advance_ticks(ticks);
        ticks
    }

    /// Canonical driver: advances exactly `ticks` fixed simulation steps.
    pub fn advance_ticks(&mut self, ticks: u32) {
        for _ in 0..ticks {
            self.step_once();
        }
    }

    /// Number of agent pairs whose surfaces overlap (distance < r_i + r_j).
    /// Deterministic; O(n * neighbors) via a dedicated spatial hash whose cell
    /// size is set to the largest pairwise radius sum.
    pub fn overlapping_pair_count(&self) -> u64 {
        let count = self.state.count as usize;
        if count == 0 {
            return 0;
        }
        let mut grid = NeighborGrid::new();
        grid.rebuild(&self.state, self.scratch_cell);
        let mut overlapping = 0u64;
        for index in 0..count {
            let agent = index as u32;
            let state = &self.state;
            grid.for_each_within(state, agent, self.scratch_cell, |other, _, _, dist| {
                if other > agent && dist < state.radius[index] + state.radius[other as usize] {
                    overlapping += 1;
                }
            });
        }
        overlapping
    }

    fn step_once(&mut self) {
        let count = self.state.count as usize;
        if count == 0 {
            self.tick += 1;
            return;
        }
        let group_count = self.group_count();
        let active_group = (self.tick % u64::from(group_count)) as u32;
        // Decision phase reads pre-step positions only; integration happens
        // after every decision, so batched and unbatched agents never see
        // partially-updated state.
        self.grid
            .rebuild(&self.state, self.config.separation_radius);
        for index in 0..count {
            if (index as u32) % group_count != active_group {
                continue;
            }
            self.decide(index as u32);
        }
        let dt = SIM_STEP_DT;
        for index in 0..count {
            self.state.px[index] += self.state.vx[index] * dt;
            self.state.pz[index] += self.state.vz[index] * dt;
        }
        for index in 0..count {
            self.resolve_walls(index);
            self.check_arrival(index);
        }
        self.tick += 1;
    }

    fn decide(&mut self, agent: u32) {
        let index = agent as usize;
        if self.state.arrived[index] {
            self.state.vx[index] = 0.0;
            self.state.vz[index] = 0.0;
            return;
        }
        let config = self.config;
        let px = self.state.px[index];
        let pz = self.state.pz[index];
        let radius = self.state.radius[index];
        let speed_cap = self.state.max_speed[index];
        let goal_dx = self.state.gx[index] - px;
        let goal_dz = self.state.gz[index] - pz;
        let goal_dist = (goal_dx * goal_dx + goal_dz * goal_dz).sqrt();
        if goal_dist <= config.arrival_radius {
            // Finalize pass owns the arrival event; leave velocity untouched.
            return;
        }
        let inv_goal = 1.0 / goal_dist;
        let dir_x = goal_dx * inv_goal;
        let dir_z = goal_dz * inv_goal;

        // Bounded separation repulsion + nearest-ahead gap probe, in fixed
        // neighbor order (cells row-major, ascending agent index).
        let mut sep_x = 0.0f32;
        let mut sep_z = 0.0f32;
        let mut best_gap = f32::INFINITY;
        {
            let grid = &self.grid;
            let state = &self.state;
            grid.for_each_within(
                state,
                agent,
                config.separation_radius,
                |other, ddx, ddz, dist| {
                    let weight = (config.separation_radius - dist) / config.separation_radius;
                    if dist > 1e-5 {
                        let inv = 1.0 / dist;
                        sep_x -= ddx * inv * weight;
                        sep_z -= ddz * inv * weight;
                    } else {
                        // Coincident agents: deterministic fixed push direction.
                        sep_x -= 1.0;
                    }
                    // Arrived agents never move again, so waiting behind one is a
                    // deadlock, not a queue: only unarrived neighbors may trigger
                    // the standstill.
                    if state.arrived[other as usize] {
                        return;
                    }
                    // Queue probe cone: only neighbors that truly block the path
                    // (within ~32 degrees of the goal direction) trigger the
                    // standstill. A wide cone freezes diagonal neighbor chains
                    // that separation alone would resolve.
                    let inv = if dist > 1e-5 { 1.0 / dist } else { 0.0 };
                    let ahead = dir_x * ddx * inv + dir_z * ddz * inv;
                    if ahead > 0.85 {
                        let gap = dist - radius - state.radius[other as usize];
                        if gap < best_gap {
                            best_gap = gap;
                        }
                    }
                },
            );
        }
        // Clamp the separation vector so total speed stays bounded by
        // max_speed + separation_gain regardless of neighbor count.
        let sep_norm = (sep_x * sep_x + sep_z * sep_z).sqrt();
        if sep_norm > 1.0 {
            let inv = 1.0 / sep_norm;
            sep_x *= inv;
            sep_z *= inv;
        }
        // Explicit queueing: a neighbor ahead closer than stop_gap freezes
        // forward motion; the slowdown band ramps speed back up as the gap
        // reopens. This makes narrow gates form standstill queues instead of
        // oscillating side-to-side.
        let scale = if best_gap <= config.stop_gap {
            0.0
        } else if best_gap < config.stop_gap + config.slowdown_band {
            (best_gap - config.stop_gap) / config.slowdown_band
        } else {
            1.0
        };
        let forward = speed_cap * scale;
        let mut vel_x = dir_x * forward + sep_x * config.separation_gain;
        let mut vel_z = dir_z * forward + sep_z * config.separation_gain;
        // Wall-aware slide: if this velocity would carry the agent into a
        // wall's inflated bounds, strip the component pointing into the wall
        // and replace the tangential component with a deterministic half-speed
        // slide toward the nearer end of the wall face. Without this, an agent
        // whose goal lies exactly perpendicular to a wall gets pinned to the
        // face forever (normal component clamped, tangential zero or cancelled
        // by separation) and everyone queueing behind it freezes with it. The
        // tangential override is unconditional (not thresholded) because a
        // separation-contaminated tangential component can otherwise hover at
        // the knife's edge and stall the whole follower chain behind it.
        let dt = SIM_STEP_DT;
        let slide_speed = speed_cap * 0.5;
        for wall in &self.walls {
            let min_x = wall.min_x - radius;
            let max_x = wall.max_x + radius;
            let min_z = wall.min_z - radius;
            let max_z = wall.max_z + radius;
            let next_x = px + vel_x * dt;
            let next_z = pz + vel_z * dt;
            if next_x > min_x && next_x < max_x && next_z > min_z && next_z < max_z {
                let pen_left = next_x - min_x;
                let pen_right = max_x - next_x;
                let pen_near = next_z - min_z;
                let pen_far = max_z - next_z;
                let min_pen = pen_left.min(pen_right).min(pen_near).min(pen_far);
                if min_pen == pen_left || min_pen == pen_right {
                    // Long-face hit: slide along the face toward its nearer
                    // end at half speed. An unconditional tangential override
                    // is required because a separation-contaminated tangential
                    // component can hover at the stall threshold and freeze
                    // the whole follower chain behind the slider.
                    vel_x = 0.0;
                    let sign = if pz < (min_z + max_z) * 0.5 {
                        -1.0
                    } else {
                        1.0
                    };
                    vel_z = sign * slide_speed;
                } else {
                    // End-cap hit: only strip the component pointing into the
                    // wall and keep the tangential one, so the agent walks
                    // straight past the wall end. Overriding the tangential
                    // component here would make it pace back and forth at the
                    // corner forever.
                    if min_pen == pen_near {
                        vel_z = vel_z.min(0.0);
                    } else {
                        vel_z = vel_z.max(0.0);
                    }
                }
            }
        }
        self.state.vx[index] = vel_x;
        self.state.vz[index] = vel_z;
    }

    /// Resolves agent `index` against every wall inflated by its radius using
    /// minimum-penetration axis push-out; the blocked velocity component is
    /// clamped so motion slides along the wall face.
    fn resolve_walls(&mut self, index: usize) {
        if self.walls.is_empty() {
            return;
        }
        let radius = self.state.radius[index];
        let mut px = self.state.px[index];
        let mut pz = self.state.pz[index];
        let mut vx = self.state.vx[index];
        let mut vz = self.state.vz[index];
        for wall in &self.walls {
            let min_x = wall.min_x - radius;
            let max_x = wall.max_x + radius;
            let min_z = wall.min_z - radius;
            let max_z = wall.max_z + radius;
            if px > min_x && px < max_x && pz > min_z && pz < max_z {
                let pen_left = px - min_x;
                let pen_right = max_x - px;
                let pen_near = pz - min_z;
                let pen_far = max_z - pz;
                let min_pen = pen_left.min(pen_right).min(pen_near).min(pen_far);
                if min_pen == pen_left {
                    px = min_x;
                    vx = vx.min(0.0);
                } else if min_pen == pen_right {
                    px = max_x;
                    vx = vx.max(0.0);
                } else if min_pen == pen_near {
                    pz = min_z;
                    vz = vz.min(0.0);
                } else {
                    pz = max_z;
                    vz = vz.max(0.0);
                }
            }
        }
        self.state.px[index] = px;
        self.state.pz[index] = pz;
        self.state.vx[index] = vx;
        self.state.vz[index] = vz;
    }

    fn check_arrival(&mut self, index: usize) {
        if self.state.arrived[index] {
            return;
        }
        let dx = self.state.gx[index] - self.state.px[index];
        let dz = self.state.gz[index] - self.state.pz[index];
        if dx * dx + dz * dz <= self.config.arrival_radius * self.config.arrival_radius {
            self.state.arrived[index] = true;
            self.state.vx[index] = 0.0;
            self.state.vz[index] = 0.0;
            self.events.push(CrowdEvent {
                tick: self.tick,
                agent: index as u32,
                kind: CrowdEventKind::Arrived,
            });
        }
    }
}

#[cfg(test)]
#[path = "runtime_navigation_crowd_tests.rs"]
mod tests;
