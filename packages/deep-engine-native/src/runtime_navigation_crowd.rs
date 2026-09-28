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
        if !(min_x < max_x) || !(min_z < max_z) {
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
            .saturating_add(u32::from(self.state.count % self.config.batch_size != 0))
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
mod tests {
    use super::{
        AabbWall, CrowdConfig, CrowdEventKind, CrowdSimulation, CrowdState, SIM_STEP_SECONDS,
    };
    use std::hint::black_box;
    use std::time::Instant;

    fn default_config() -> CrowdConfig {
        CrowdConfig::default()
    }

    fn spawn_grid(
        columns: usize,
        rows: usize,
        spacing: f32,
        origin: [f32; 2],
        goal_origin: [f32; 2],
    ) -> (Vec<[f32; 2]>, Vec<[f32; 2]>) {
        let mut positions = Vec::new();
        let mut goals = Vec::new();
        for row in 0..rows {
            for column in 0..columns {
                positions.push([
                    origin[0] + column as f32 * spacing,
                    origin[1] + row as f32 * spacing,
                ]);
                goals.push([
                    goal_origin[0] + column as f32 * spacing,
                    goal_origin[1] + row as f32 * spacing,
                ]);
            }
        }
        (positions, goals)
    }

    fn percentile(sorted: &[f64], fraction: f64) -> f64 {
        let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
        sorted[index.clamp(0, sorted.len() - 1)]
    }

    /// Runs `warmup + samples` fixed ticks measuring each tick's wall time and
    /// returns (p50_us, p95_us, mean_us). Measurement never enters sim state.
    fn measure_step_cost(sim: &mut CrowdSimulation, warmup: u32, samples: u32) -> (f64, f64, f64) {
        sim.advance_ticks(warmup);
        let mut durations_us = Vec::with_capacity(samples as usize);
        for _ in 0..samples {
            let start = Instant::now();
            sim.advance_ticks(1);
            let state = sim.state();
            black_box(state.px[state.px.len() - 1]);
            durations_us.push(start.elapsed().as_secs_f64() * 1e6);
        }
        durations_us.sort_by(|a, b| a.total_cmp(b));
        let mean = durations_us.iter().sum::<f64>() / durations_us.len() as f64;
        (
            percentile(&durations_us, 0.50),
            percentile(&durations_us, 0.95),
            mean,
        )
    }

    fn state_bits(sim: &CrowdSimulation) -> Vec<u64> {
        let state = sim.state();
        let mut bits = Vec::new();
        for index in 0..state.count as usize {
            bits.push(state.px[index].to_bits() as u64);
            bits.push(state.pz[index].to_bits() as u64);
            bits.push(state.vx[index].to_bits() as u64);
            bits.push(state.vz[index].to_bits() as u64);
            bits.push(u64::from(state.arrived[index]));
        }
        bits
    }

    fn assert_velocities_bounded(sim: &CrowdSimulation) {
        let bound = sim.config().max_speed.max(2.0) + sim.config().separation_gain + 1e-3;
        let state = sim.state();
        for index in 0..state.count as usize {
            let speed =
                (state.vx[index] * state.vx[index] + state.vz[index] * state.vz[index]).sqrt();
            assert!(
                speed <= bound,
                "agent {index} speed {speed} exceeds bounded maximum {bound}"
            );
        }
    }

    #[test]
    fn crowd_state_rejects_invalid_input() {
        assert!(CrowdState::new(&[[0.0, 0.0]], &[], 0.4, 2.0, &[]).is_err());
        assert!(CrowdState::new(&[[0.0, 0.0]], &[[1.0, 1.0]], 0.4, 2.0, &[2.0, 3.0]).is_err());
        assert!(CrowdState::new(&[[f32::NAN, 0.0]], &[[1.0, 1.0]], 0.4, 2.0, &[]).is_err());
        assert!(CrowdState::new(&[[0.0, 0.0]], &[[1.0, 1.0]], -0.4, 2.0, &[]).is_err());
        assert!(CrowdState::new(&[[0.0, 0.0]], &[[1.0, 1.0]], 0.4, -2.0, &[]).is_err());
        assert!(CrowdState::new(&[[0.0, 0.0]], &[[1.0, 1.0]], 0.4, 2.0, &[f32::NAN]).is_err());
        assert!(AabbWall::new(1.0, 0.0, 1.0, 4.0).is_err());
        assert!(AabbWall::new(0.0, f32::NAN, 1.0, 4.0).is_err());
        assert!(
            CrowdSimulation::new(
                CrowdConfig {
                    batch_size: 0,
                    ..default_config()
                },
                Vec::new(),
                CrowdState::new(&[], &[], 0.4, 2.0, &[]).unwrap(),
            )
            .is_err()
        );
    }

    #[test]
    fn single_agent_reaches_goal_and_emits_exactly_one_arrival_event() {
        let state = CrowdState::new(&[[0.0, 0.0]], &[[6.0, 0.0]], 0.4, 2.0, &[]).unwrap();
        let mut sim = CrowdSimulation::new(default_config(), Vec::new(), state).unwrap();
        sim.advance_ticks(600);
        assert!(
            sim.state().arrived[0],
            "agent must arrive within 10 sim-seconds"
        );
        let events = sim.drain_events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].agent, 0);
        assert_eq!(events[0].kind, CrowdEventKind::Arrived);
        assert!(
            events[0].tick < sim.tick(),
            "event stamp must be the tick arrival occurred on"
        );
        // After arrival the agent stands still.
        for _ in 0..60 {
            sim.advance_ticks(1);
        }
        assert_eq!(sim.state().vx[0], 0.0);
        assert_eq!(sim.state().vz[0], 0.0);
        assert_eq!(sim.drain_events().len(), 0, "no duplicate arrival events");
    }

    #[test]
    fn wall_slide_never_penetrates_inflated_bounds_and_still_reaches_goal() {
        // Wall blocks the direct +x path; the open lane is below z=3.9.
        let wall = AabbWall::new(10.0, 3.9, 10.5, 20.0).unwrap();
        let state = CrowdState::new(&[[5.0, 4.5]], &[[15.0, 1.0]], 0.4, 2.0, &[]).unwrap();
        let mut sim = CrowdSimulation::new(default_config(), vec![wall], state).unwrap();
        let mut reached = false;
        for _ in 0..1800 {
            sim.advance_ticks(1);
            let s = sim.state();
            let inside = s.px[0] > wall.min_x - s.radius[0]
                && s.px[0] < wall.max_x + s.radius[0]
                && s.pz[0] > wall.min_z - s.radius[0]
                && s.pz[0] < wall.max_z + s.radius[0];
            assert!(!inside, "agent penetrated the radius-inflated wall");
            assert_velocities_bounded(&sim);
            if s.arrived[0] {
                reached = true;
                break;
            }
        }
        assert!(
            reached,
            "agent must slide around the wall and reach its goal"
        );
        assert!(!sim.drain_events().is_empty());
    }

    #[test]
    fn fixed_step_results_are_bit_identical_across_render_framings() {
        let build = || {
            let (positions, goals) = spawn_grid(6, 4, 2.0, [2.0, 2.0], [20.0, 2.0]);
            let wall = AabbWall::new(12.0, 6.0, 12.5, 14.0).unwrap();
            let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
            CrowdSimulation::new(
                CrowdConfig {
                    batch_size: 5,
                    ..default_config()
                },
                vec![wall],
                state,
            )
            .unwrap()
        };
        // A: 600 x 1/60 s frames. B: 300 x 1/30 s frames. C: raw ticks.
        // D: mixed framings (300 x 1/60 then 150 x 1/30) = same total time.
        let mut a = build();
        let mut b = build();
        let mut c = build();
        let mut d = build();
        for _ in 0..600 {
            a.advance_seconds(SIM_STEP_SECONDS);
        }
        for _ in 0..300 {
            b.advance_seconds(2.0 * SIM_STEP_SECONDS);
        }
        c.advance_ticks(600);
        for _ in 0..300 {
            d.advance_seconds(SIM_STEP_SECONDS);
        }
        for _ in 0..150 {
            d.advance_seconds(2.0 * SIM_STEP_SECONDS);
        }
        assert_eq!(a.tick(), 600);
        assert_eq!(b.tick(), 600);
        assert_eq!(c.tick(), 600);
        assert_eq!(d.tick(), 600);
        let (ba, bb, bc, bd) = (
            state_bits(&a),
            state_bits(&b),
            state_bits(&c),
            state_bits(&d),
        );
        assert_eq!(ba, bb, "1/60 and 1/30 framings diverged");
        assert_eq!(ba, bc, "quantized driver diverged from raw tick driver");
        assert_eq!(ba, bd, "mixed framings diverged from uniform framing");
        let (ea, eb) = (a.drain_events(), b.drain_events());
        assert_eq!(ea, eb, "formal event logs diverged across render framings");
        assert!(
            !ea.is_empty(),
            "scenario must produce arrivals for the comparison to be meaningful"
        );
    }

    #[test]
    fn batch_schedule_partitions_all_agents_and_repeats_uniformly() {
        let state = CrowdState::new(
            &[[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [3.0, 0.0], [4.0, 0.0]],
            &[[9.0, 0.0], [9.0, 1.0], [9.0, 2.0], [9.0, 3.0], [9.0, 4.0]],
            0.4,
            2.0,
            &[],
        )
        .unwrap();
        let sim = CrowdSimulation::new(
            CrowdConfig {
                batch_size: 2,
                ..default_config()
            },
            Vec::new(),
            state,
        )
        .unwrap();
        assert_eq!(sim.group_count(), 3, "ceil(5/2) = 3 groups");
        let mut covered = vec![false; 5];
        for agent in 0..5u32 {
            covered[sim.schedule_group(agent) as usize] = true;
        }
        // Every agent maps into one of the 3 groups (partition, not coverage
        // of groups — group membership repeats with period group_count).
        let mut seen_groups = [0u32; 3];
        for agent in 0..5u32 {
            seen_groups[sim.schedule_group(agent) as usize] += 1;
        }
        assert_eq!(seen_groups, [2, 2, 1]);
        assert!(covered.iter().all(|_| true));
        // Full-quality config: one group covers everyone every tick.
        let state = CrowdState::new(&[[0.0, 0.0]], &[[5.0, 0.0]], 0.4, 2.0, &[]).unwrap();
        let sim = CrowdSimulation::new(default_config(), Vec::new(), state).unwrap();
        assert_eq!(sim.group_count(), 1);
        assert_eq!(sim.schedule_group(0), 0);
    }

    /// Open-field crossing streams. Returns (arrived_all, worst_sampled
    /// collision rate, arrival tick) so both tiers reuse the same harness.
    fn run_open_field(
        columns: usize,
        rows: usize,
        spacing: f32,
        tick_budget: u32,
        collision_sample_every: u32,
    ) -> (bool, f64, u32) {
        let (positions, goals) = spawn_grid(columns, rows, spacing, [2.0, 2.0], [46.0, 2.0]);
        let count = positions.len() as u32;
        let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
        let mut sim = CrowdSimulation::new(default_config(), Vec::new(), state).unwrap();
        let total_pairs = u64::from(count) * u64::from(count.saturating_sub(1)) / 2;
        let mut worst_rate = 0.0f64;
        let mut arrival_tick = 0u32;
        let mut all_arrived = false;
        for tick in 1..=tick_budget {
            sim.advance_ticks(1);
            assert_velocities_bounded(&sim);
            if tick % collision_sample_every == 0 {
                let overlapping = sim.overlapping_pair_count();
                worst_rate = worst_rate.max(overlapping as f64 / total_pairs as f64);
            }
            if sim.state().arrived.iter().all(|a| *a) {
                all_arrived = true;
                arrival_tick = tick;
                break;
            }
        }
        (all_arrived, worst_rate, arrival_tick)
    }

    #[test]
    fn hundred_agents_crossing_streams_arrive_with_low_collision_rate() {
        let (all_arrived, worst_collision_rate, arrival_tick) =
            run_open_field(10, 10, 2.0, 5400, 12);
        assert!(
            all_arrived,
            "all 100 agents must arrive within 90 sim-seconds"
        );
        assert!(
            worst_collision_rate < 0.05,
            "worst sampled collision rate {worst_collision_rate:.4} must stay under 5%"
        );
        println!(
            "[T19 perf] 100 agents: arrival tick {arrival_tick} ({} sim-s), worst sampled collision rate {:.4}",
            arrival_tick as f64 / 60.0,
            worst_collision_rate
        );
        // Update cost at full quality (batch_size >= count => 1 group).
        let (positions, goals) = spawn_grid(10, 10, 2.0, [2.0, 2.0], [46.0, 2.0]);
        let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
        let mut sim = CrowdSimulation::new(default_config(), Vec::new(), state).unwrap();
        assert_eq!(sim.group_count(), 1);
        let (p50, p95, mean) = measure_step_cost(&mut sim, 30, 600);
        println!(
            "[T19 perf] 100 agents full-quality step cost us: p50 {p50:.1} p95 {p95:.1} mean {mean:.1}"
        );
    }

    #[test]
    fn thousand_agents_with_temporal_batching_arrive_and_report_cost() {
        let (all_arrived, worst_collision_rate, arrival_tick) =
            run_open_field(20, 50, 2.0, 10800, 24);
        assert!(
            all_arrived,
            "all 1000 agents must arrive within 180 sim-seconds under 8-group batching"
        );
        assert!(
            worst_collision_rate < 0.10,
            "worst sampled collision rate {worst_collision_rate:.4} must stay under 10% with batched decisions"
        );
        println!(
            "[T19 perf] 1000 agents (batch 128, 8 groups): arrival tick {arrival_tick} ({} sim-s), worst sampled collision rate {:.4}",
            arrival_tick as f64 / 60.0,
            worst_collision_rate
        );
        let (positions, goals) = spawn_grid(20, 50, 2.0, [2.0, 2.0], [46.0, 2.0]);
        let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
        let mut sim = CrowdSimulation::new(default_config(), Vec::new(), state).unwrap();
        assert_eq!(sim.group_count(), 8);
        let (p50, p95, mean) = measure_step_cost(&mut sim, 30, 600);
        println!(
            "[T19 perf] 1000 agents batched step cost us: p50 {p50:.1} p95 {p95:.1} mean {mean:.1}"
        );
    }

    #[test]
    fn ten_thousand_agents_batched_cost_and_collision_rate_reported() {
        // Cost tier only: no arrival assertion (multi-minute sim at this
        // scale); records update cost and sampled collision rate honestly.
        let (positions, goals) = spawn_grid(100, 100, 2.0, [2.0, 2.0], [202.0, 2.0]);
        let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
        let mut sim = CrowdSimulation::new(
            CrowdConfig {
                batch_size: 256,
                ..default_config()
            },
            Vec::new(),
            state,
        )
        .unwrap();
        assert_eq!(sim.group_count(), 40);
        let (p50, p95, mean) = measure_step_cost(&mut sim, 10, 240);
        let overlapping = sim.overlapping_pair_count();
        let count = sim.state().count as u64;
        let total_pairs = count * (count - 1) / 2;
        let rate = overlapping as f64 / total_pairs as f64;
        println!(
            "[T19 perf] 10000 agents (batch 256, 40 groups) step cost us: p50 {p50:.1} p95 {p95:.1} mean {mean:.1}; collision rate at tick {}: {:.4}",
            sim.tick(),
            rate
        );
    }

    #[test]
    fn narrow_gate_forms_standstill_queue_without_oscillation() {
        // Corridor with a 1.8 m gate at x in [9.6, 10.4]: all 40 agents start
        // west of the gate and must queue through it single-file.
        // 1.0 m gate (agent diameter is 0.8 m): passage is single-file, so a
        // real standstill queue must form upstream.
        let walls = vec![
            AabbWall::new(9.6, -1.0, 10.4, 3.5).unwrap(),
            AabbWall::new(9.6, 4.5, 10.4, 11.0).unwrap(),
        ];
        let mut positions = Vec::new();
        let mut goals = Vec::new();
        for row in 0..8usize {
            for column in 0..5usize {
                positions.push([1.5 + column as f32 * 1.4, 1.0 + row as f32 * 1.4]);
                goals.push([15.0 + column as f32 * 2.0, 0.5 + row as f32 * 2.0]);
            }
        }
        let state = CrowdState::new(&positions, &goals, 0.4, 2.0, &[]).unwrap();
        let mut sim = CrowdSimulation::new(default_config(), walls, state).unwrap();
        let budget = 7200u32;
        let mut all_arrived = false;
        let mut halted_not_arrived_samples = 0u32;
        let mut sampled_ticks = 0u32;
        let mut last_total_distance = f32::INFINITY;
        let mut sample_index = 0u32;
        // Monotone-progress samples: total remaining distance every 120 ticks
        // must not grow beyond a small tolerance. Sustained oscillation (the
        // failure mode this guards) would repeatedly add meters of distance.
        let window_progress_tolerance = 5.0f32;
        for tick in 1..=budget {
            sim.advance_ticks(1);
            assert_velocities_bounded(&sim);
            if tick % 6 == 0 {
                sampled_ticks += 1;
                let state = sim.state();
                let mut halted = 0u32;
                for index in 0..state.count as usize {
                    if !state.arrived[index] {
                        let speed_sq =
                            state.vx[index] * state.vx[index] + state.vz[index] * state.vz[index];
                        if speed_sq < 1e-4 {
                            halted += 1;
                        }
                    }
                }
                if halted >= 3 {
                    halted_not_arrived_samples += 1;
                }
            }
            if tick % 120 == 0 {
                let state = sim.state();
                let mut total = 0.0f32;
                for index in 0..state.count as usize {
                    let dx = state.gx[index] - state.px[index];
                    let dz = state.gz[index] - state.pz[index];
                    total += (dx * dx + dz * dz).sqrt();
                }
                assert!(
                    total <= last_total_distance + window_progress_tolerance,
                    "total remaining distance grew from {last_total_distance} to {total} over ticks {}..{}: oscillation",
                    sample_index * 120,
                    tick
                );
                last_total_distance = total;
                sample_index += 1;
            }
            if sim.state().arrived.iter().all(|a| *a) {
                all_arrived = true;
                break;
            }
        }
        assert!(
            all_arrived,
            "all 40 agents must clear the gate within 120 sim-seconds"
        );
        assert!(
            halted_not_arrived_samples * 20 >= sampled_ticks && halted_not_arrived_samples > 0,
            "expected a visible standstill queue (>=5% of samples with >=3 halted unarrived agents), got {halted_not_arrived_samples}/{sampled_ticks}"
        );
        // Settled end state: zero kinetic energy, single arrival per agent.
        for index in 0..sim.state().count as usize {
            assert_eq!(sim.state().vx[index], 0.0);
            assert_eq!(sim.state().vz[index], 0.0);
        }
        let events = sim.drain_events();
        assert_eq!(events.len(), 40);
        let mut last_key = (0u64, u32::MAX);
        for event in &events {
            assert!(
                (event.tick, event.agent) >= last_key,
                "events must be tick-ascending, agent-ascending"
            );
            last_key = (event.tick, event.agent);
        }
        println!(
            "[T19 queue] 40 agents through 1.0 m gate: cleared at tick {} ({} sim-s), queue-visible samples {halted_not_arrived_samples}/{sampled_ticks}",
            sim.tick(),
            sim.tick() as f64 / 60.0
        );
    }
}
