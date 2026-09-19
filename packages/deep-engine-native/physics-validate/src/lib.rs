//! R10 物理选型验证库:Rapier 固定步长确定性 + physics-frame-v1 跨端合同。

pub mod contract;
pub mod hash;
pub mod runner;

pub use contract::{
    canonical_frame, first_bit_divergence, summarize, FrameRecord, FrameSummary, Pose,
};
pub use runner::{parse_spec, run_scene, RunOutcome, SceneSpec};
