//! R3 canonical state-frame contract (`r3-state-frame-v1`): the byte-exact
//! cross-end counterpart of `apps/web/src/delivery/r3StateFrame.ts`. It folds a
//! frozen clipping/selection op sequence into canonical per-step frames and
//! surfaces data-replay revisions sampled from the frozen package.
//!
//! Float discipline (designed before code, shared with the TS consumer): every
//! floating contract input is quantized onto the 1e-3 grid and bounded to
//! |v| <= 1000. The native player applies these values as f32 (ULP at 1000 is
//! ~1.22e-4, well below the 5e-4 quantization threshold), so an applied value
//! round-trips f64 -> f32 -> quantize byte-exactly. `-0` normalizes to `0` and
//! every component prints with a fixed 6-decimal format, matching the TS
//! `toFixed(6)` bytes including the dynamic-frame-v1 zero guard.

use serde::Deserialize;

pub const R3_STATE_OPS_SCHEMA: &str = "deep-monkey.r3-state-ops";
pub const R3_STATE_FRAME_CONTRACT: &str = "r3-state-frame-v1";
const MAX_STEPS: usize = 4096;
const QUANTUM: f64 = 0.001;
const MAX_COORD: f64 = 1000.0;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct R3StateOps {
    pub schema: String,
    pub schema_version: u32,
    pub id: String,
    pub package_hash: String,
    pub steps: Vec<R3StateStep>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct R3StateStep {
    pub at_ms: u64,
    pub op: R3StateOp,
}

/// Flat op envelope: unknown JSON fields are rejected structurally, and each
/// `kind` then validates which fields are required or forbidden, mirroring the
/// TS op parsing field by field.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct R3StateOp {
    pub kind: String,
    pub axis: Option<String>,
    pub inverted: Option<bool>,
    pub offset: Option<f64>,
    pub target_id: Option<String>,
    pub r#box: Option<R3StateBox>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct R3StateBox {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClipState {
    Off,
    Axis {
        axis: char,
        inverted: bool,
        offset: f64,
    },
    Box {
        min: [f64; 3],
        max: [f64; 3],
    },
}

fn fail<T>(message: impl AsRef<str>) -> Result<T, String> {
    Err(format!("r3-state ops: {}", message.as_ref()))
}

fn validate_coordinate(value: f64, context: &str) -> Result<f64, String> {
    if !value.is_finite() {
        return fail(format!("{context} must be a finite number"));
    }
    if value.abs() > MAX_COORD {
        return fail(format!(
            "{context} exceeds the ±{} contract bound",
            MAX_COORD as u64
        ));
    }
    if (value / QUANTUM - (value / QUANTUM).round()).abs() > 1e-6 {
        return fail(format!("{context} must sit on the {QUANTUM} grid"));
    }
    Ok((value / QUANTUM).round() * QUANTUM)
}

fn validate_target_id(value: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    let first_ok = bytes.first().is_some_and(|c| {
        c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b':' | b'/')
    });
    let rest_ok = bytes.iter().all(|c| {
        c.is_ascii_lowercase()
            || c.is_ascii_digit()
            || matches!(c, b'.' | b'_' | b':' | b'/' | b'-')
    });
    if value.is_empty() || value.len() > 256 || !first_ok || !rest_ok {
        return fail(
            "select requires a targetId of [a-z0-9._:/] followed by [a-z0-9._:/-] with at most 256 bytes",
        );
    }
    Ok(())
}

impl R3StateOp {
    fn validate(&self) -> Result<(), String> {
        match self.kind.as_str() {
            "clip-enable" => {
                let axis = self.axis.as_deref().unwrap_or_default();
                if !matches!(axis, "x" | "y" | "z") {
                    return fail("clip-enable requires axis x|y|z");
                }
                if self.inverted.is_none() {
                    return fail("clip-enable requires an explicit boolean inverted");
                }
                if self.offset.is_none() {
                    return fail("clip-enable requires offset");
                }
                validate_coordinate(self.offset.unwrap_or(f64::NAN), "clip-enable offset")
                    .map(|_| ())
            }
            "clip-move" => {
                if self.offset.is_none() {
                    return fail("clip-move requires offset");
                }
                validate_coordinate(self.offset.unwrap_or(f64::NAN), "clip-move offset").map(|_| ())
            }
            "box-enable" => {
                let Some(boxed) = &self.r#box else {
                    return fail("box-enable requires box {min,max}");
                };
                let mut min = [0.0; 3];
                let mut max = [0.0; 3];
                for index in 0..3 {
                    min[index] = validate_coordinate(boxed.min[index], "box min component")?;
                    max[index] = validate_coordinate(boxed.max[index], "box max component")?;
                    if min[index] > max[index] {
                        return fail("box-enable min must not exceed max component-wise");
                    }
                }
                Ok(())
            }
            "clip-disable" => Ok(()),
            "select" => match &self.target_id {
                Some(target) => validate_target_id(target),
                None => fail("select requires a targetId"),
            },
            "clear-selection" => Ok(()),
            other => fail(format!("unknown op kind {other}")),
        }
    }
}

pub fn parse_and_validate_r3_state_ops(value: serde_json::Value) -> Result<R3StateOps, String> {
    let ops: R3StateOps =
        serde_json::from_value(value).map_err(|error| format!("r3-state ops: {error}"))?;
    if ops.schema != R3_STATE_OPS_SCHEMA || ops.schema_version != 1 {
        return fail("unsupported schema or schemaVersion");
    }
    if ops.id.is_empty() {
        return fail("id must be a non-empty string");
    }
    if ops.package_hash.len() != 64
        || !ops
            .package_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return fail("packageHash must be a lowercase sha-256 hex string");
    }
    if ops.steps.is_empty() || ops.steps.len() > MAX_STEPS {
        return fail(format!("steps must hold 1..{MAX_STEPS} entries"));
    }
    let mut previous_at_ms: Option<u64> = None;
    for (index, step) in ops.steps.iter().enumerate() {
        if step.at_ms > 86_400_000 {
            return fail(format!(
                "step {index} atMs must be an integer in [0, 86400000]"
            ));
        }
        if previous_at_ms.is_some_and(|previous| step.at_ms < previous) {
            return fail(format!("step {index} atMs must not move backwards"));
        }
        previous_at_ms = Some(step.at_ms);
        step.op
            .validate()
            .map_err(|error| format!("step {index}: {error}"))?;
    }
    Ok(ops)
}

/// Formats one contract component: `-0` normalized, fixed 6 decimals — the same
/// bytes as the TS `formatComponent`.
fn format_component(value: f64) -> String {
    format!("{:.6}", if value == 0.0 { 0.0 } else { value })
}

/// Canonical clip field, byte-identical with the TS `clipField`.
pub fn clip_field(clip: &ClipState) -> String {
    match clip {
        ClipState::Off => "off".into(),
        ClipState::Axis {
            axis,
            inverted,
            offset,
        } => {
            format!(
                "axis:{axis},dir={},off={}",
                if *inverted { -1 } else { 1 },
                format_component(*offset)
            )
        }
        ClipState::Box { min, max } => format!(
            "box:min={},{},{},max={},{},{}",
            format_component(min[0]),
            format_component(min[1]),
            format_component(min[2]),
            format_component(max[0]),
            format_component(max[1]),
            format_component(max[2]),
        ),
    }
}

pub fn selection_field(selection: Option<&str>) -> String {
    selection.unwrap_or("-").to_string()
}

/// Folds the frozen op sequence up to `step_index` and emits the canonical
/// frame; `replay_revisions` are sampled by the caller from its own package
/// parser so the events field proves both ends read the same frozen channel.
pub fn canonical_r3_state_frame(
    ops: &R3StateOps,
    step_index: usize,
    replay_revisions: &[u64],
) -> Result<(u64, String, ClipState, Option<String>), String> {
    if step_index >= ops.steps.len() {
        return fail(format!(
            "step index {step_index} is outside the frozen sequence"
        ));
    }
    let mut clip = ClipState::Off;
    let mut selection: Option<String> = None;
    for step in &ops.steps[..=step_index] {
        let op = &step.op;
        match op.kind.as_str() {
            "clip-enable" => {
                clip = ClipState::Axis {
                    axis: op
                        .axis
                        .as_ref()
                        .expect("validated")
                        .chars()
                        .next()
                        .expect("non-empty"),
                    inverted: op.inverted.expect("validated"),
                    offset: (op.offset.expect("validated") / QUANTUM).round() * QUANTUM,
                };
            }
            "clip-move" => match &clip {
                ClipState::Axis { axis, inverted, .. } => {
                    clip = ClipState::Axis {
                        axis: *axis,
                        inverted: *inverted,
                        offset: (op.offset.expect("validated") / QUANTUM).round() * QUANTUM,
                    };
                }
                _ => {
                    return fail(format!(
                        "clip-move at step {} requires an enabled axis clip",
                        step_index
                    ));
                }
            },
            "box-enable" => {
                let boxed = op.r#box.as_ref().expect("validated");
                let mut min = [0.0; 3];
                let mut max = [0.0; 3];
                for index in 0..3 {
                    min[index] = (boxed.min[index] / QUANTUM).round() * QUANTUM;
                    max[index] = (boxed.max[index] / QUANTUM).round() * QUANTUM;
                }
                clip = ClipState::Box { min, max };
            }
            "clip-disable" => clip = ClipState::Off,
            "select" => selection = Some(op.target_id.clone().expect("validated")),
            "clear-selection" => selection = None,
            other => return fail(format!("unknown op kind {other}")),
        }
    }
    let step = &ops.steps[step_index];
    let revisions = replay_revisions
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let canonical = format!(
        "{}|i={}|t={}|clip={}|sel={}|events={}",
        R3_STATE_FRAME_CONTRACT,
        step_index,
        step.at_ms,
        clip_field(&clip),
        selection_field(selection.as_deref()),
        revisions,
    );
    Ok((step.at_ms, canonical, clip, selection))
}

/// Contract plane for an axis (or off) clip in the player's plane convention
/// `[nx, ny, nz, d]` with `d = -offset*dir`; these exact f64 values are what
/// the native player downcasts to f32 when applying the contract state.
pub fn axis_clip_plane(clip: &ClipState) -> Result<[f64; 4], String> {
    match clip {
        ClipState::Off => Ok([0.0; 4]),
        ClipState::Axis {
            axis,
            inverted,
            offset,
        } => {
            let index = match axis {
                'x' => 0usize,
                'y' => 1,
                'z' => 2,
                other => return fail(format!("unknown axis {other}")),
            };
            let dir: f64 = if *inverted { -1.0 } else { 1.0 };
            let mut plane = [0.0; 4];
            plane[index] = dir;
            plane[3] = -offset * dir;
            Ok(plane)
        }
        ClipState::Box { .. } => fail("box clipping has no single-plane native consumer"),
    }
}

/// Readback normalization: recovers the axis-clip contract field from the f32
/// player plane. The 1e-3 quantization restores the exact contract bytes for
/// every |offset| <= 1000 (f32 ULP at 1000 is ~1.22e-4); anything else fails
/// instead of emitting a look-alike frame.
pub fn axis_clip_field_from_plane(plane: [f32; 4]) -> Result<String, String> {
    if plane == [0.0; 4] {
        return Ok("off".into());
    }
    let Some(index) = plane[..3].iter().position(|value| *value != 0.0) else {
        return fail("plane has a zero normal with a nonzero offset");
    };
    let normal = plane[index];
    let other_axes_zero = plane[..3]
        .iter()
        .enumerate()
        .all(|(position, value)| position == index || *value == 0.0);
    if !other_axes_zero || normal.abs() != 1.0 {
        return fail("plane is not a unit axis plane; no contract field exists for it");
    }
    let dir: i64 = if normal > 0.0 { 1 } else { -1 };
    let offset = -(plane[3] as f64) * dir as f64;
    if offset.abs() > MAX_COORD {
        return fail("readback offset exceeds the contract bound");
    }
    let offset = (offset / QUANTUM).round() * QUANTUM;
    Ok(format!(
        "axis:{},dir={},off={}",
        ['x', 'y', 'z'][index],
        dir,
        format_component(offset)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frozen_ops() -> serde_json::Value {
        json!({
            "schema": R3_STATE_OPS_SCHEMA, "schemaVersion": 1, "id": "r3-state-replay",
            "packageHash": "a".repeat(64),
            "steps": [
                {"atMs": 0, "op": {"kind": "clip-enable", "axis": "z", "inverted": false, "offset": 0.125}},
                {"atMs": 100, "op": {"kind": "select", "targetId": "pump"}},
                {"atMs": 200, "op": {"kind": "clip-move", "offset": -1.25}},
                {"atMs": 300, "op": {"kind": "box-enable", "box": {"min": [-1.0, -2.0, -1.5], "max": [1.0, 2.0, 1.5]}}},
                {"atMs": 400, "op": {"kind": "clip-disable"}},
                {"atMs": 500, "op": {"kind": "clear-selection"}}
            ]
        })
    }

    fn revisions(at_ms: u64) -> Vec<u64> {
        if at_ms >= 750 {
            vec![1, 2]
        } else if at_ms >= 250 {
            vec![1]
        } else {
            vec![]
        }
    }

    #[test]
    fn produces_the_cross_end_golden_frames() {
        // Same fixture and expected strings as r3StateFrame.test.ts.
        let ops = parse_and_validate_r3_state_ops(frozen_ops()).unwrap();
        let expected = [
            "r3-state-frame-v1|i=0|t=0|clip=axis:z,dir=1,off=0.125000|sel=-|events=",
            "r3-state-frame-v1|i=1|t=100|clip=axis:z,dir=1,off=0.125000|sel=pump|events=",
            "r3-state-frame-v1|i=2|t=200|clip=axis:z,dir=1,off=-1.250000|sel=pump|events=",
            "r3-state-frame-v1|i=3|t=300|clip=box:min=-1.000000,-2.000000,-1.500000,max=1.000000,2.000000,1.500000|sel=pump|events=1",
            "r3-state-frame-v1|i=4|t=400|clip=off|sel=pump|events=1",
            "r3-state-frame-v1|i=5|t=500|clip=off|sel=-|events=1",
        ];
        for (index, expected) in expected.iter().enumerate() {
            let (_, canonical, _, _) =
                canonical_r3_state_frame(&ops, index, &revisions(ops.steps[index].at_ms)).unwrap();
            assert_eq!(&canonical, expected);
        }
    }

    #[test]
    fn normalizes_negative_zero_like_the_ts_guard() {
        let ops = parse_and_validate_r3_state_ops(json!({
            "schema": R3_STATE_OPS_SCHEMA, "schemaVersion": 1, "id": "r3", "packageHash": "a".repeat(64),
            "steps": [{"atMs": 0, "op": {"kind": "clip-enable", "axis": "x", "inverted": true, "offset": -0.0}}]
        })).unwrap();
        let (_, canonical, _, _) = canonical_r3_state_frame(&ops, 0, &[]).unwrap();
        assert_eq!(
            canonical,
            "r3-state-frame-v1|i=0|t=0|clip=axis:x,dir=-1,off=0.000000|sel=-|events="
        );
    }

    #[test]
    fn rejects_off_grid_out_of_bound_and_unknown_shapes() {
        let mut value = frozen_ops();
        value["steps"][0]["op"]["offset"] = json!(0.1005);
        assert!(
            parse_and_validate_r3_state_ops(value)
                .unwrap_err()
                .contains("must sit on the 0.001 grid")
        );
        let mut value = frozen_ops();
        value["steps"][0]["op"]["offset"] = json!(1500.0);
        assert!(
            parse_and_validate_r3_state_ops(value)
                .unwrap_err()
                .contains("contract bound")
        );
        let mut value = frozen_ops();
        // serde deserializes JSON null into Option::None, so this reaches the
        // same explicit-requires rejection as a missing field (both ends reject).
        value["steps"][0]["op"]["offset"] = json!(null);
        assert!(
            parse_and_validate_r3_state_ops(value)
                .unwrap_err()
                .contains("requires offset")
        );
        let mut value = frozen_ops();
        value["steps"][0]["extra"] = json!(1);
        assert!(
            parse_and_validate_r3_state_ops(value)
                .unwrap_err()
                .contains("unknown field `extra`")
        );
        let mut value = frozen_ops();
        value["steps"][1]["op"]["targetId"] = json!("-pump");
        assert!(
            parse_and_validate_r3_state_ops(value)
                .unwrap_err()
                .contains("targetId")
        );
        let mut value = frozen_ops();
        value["steps"][2]["atMs"] = json!(50);
        assert!(
            parse_and_validate_r3_state_ops(value)
                .unwrap_err()
                .contains("must not move backwards")
        );
        let mut value = frozen_ops();
        value["packageHash"] = json!("A".repeat(64));
        assert!(
            parse_and_validate_r3_state_ops(value)
                .unwrap_err()
                .contains("lowercase sha-256")
        );
    }

    #[test]
    fn axis_plane_application_and_readback_survive_the_f32_pipeline() {
        // Apply: contract axis clip -> f64 plane -> f32 player state.
        let ops = parse_and_validate_r3_state_ops(json!({
            "schema": R3_STATE_OPS_SCHEMA, "schemaVersion": 1, "id": "r3", "packageHash": "a".repeat(64),
            "steps": [
                {"atMs": 0, "op": {"kind": "clip-enable", "axis": "z", "inverted": false, "offset": 0.125}},
                {"atMs": 10, "op": {"kind": "clip-move", "offset": -1.25}}
            ]
        })).unwrap();
        for index in 0..2 {
            let (_, canonical, clip, _) = canonical_r3_state_frame(&ops, index, &[]).unwrap();
            let plane = axis_clip_plane(&clip).unwrap();
            let applied: [f32; 4] = plane.map(|value| value as f32);
            let applied_field = axis_clip_field_from_plane(applied).unwrap();
            let expected_clip = canonical
                .split("|clip=")
                .nth(1)
                .unwrap()
                .split('|')
                .next()
                .unwrap();
            assert_eq!(
                applied_field, expected_clip,
                "applied field must restore the contract bytes"
            );
        }
        // A non-axis plane has no contract field and must fail loudly.
        assert!(axis_clip_field_from_plane([0.5, 0.5, 0.0, -1.0]).is_err());
        assert!(axis_clip_field_from_plane([0.0, 0.0, 0.0, 4.0]).is_err());
    }

    #[test]
    fn equal_atms_is_a_legal_non_decreasing_step() {
        let ops = parse_and_validate_r3_state_ops(json!({
            "schema": R3_STATE_OPS_SCHEMA, "schemaVersion": 1, "id": "r3", "packageHash": "a".repeat(64),
            "steps": [
                {"atMs": 100, "op": {"kind": "clip-enable", "axis": "y", "inverted": false, "offset": 2.5}},
                {"atMs": 100, "op": {"kind": "clear-selection"}}
            ]
        })).unwrap();
        let (_, _, _, _) = canonical_r3_state_frame(&ops, 1, &[]).expect("equal atMs must fold");
    }

    #[test]
    fn fails_clip_move_against_a_disabled_or_box_clip() {
        let ops = parse_and_validate_r3_state_ops(json!({
            "schema": R3_STATE_OPS_SCHEMA, "schemaVersion": 1, "id": "r3", "packageHash": "a".repeat(64),
            "steps": [{"atMs": 0, "op": {"kind": "clip-move", "offset": 1.0}}]
        })).unwrap();
        assert!(
            canonical_r3_state_frame(&ops, 0, &[])
                .unwrap_err()
                .contains("requires an enabled axis clip")
        );
        let boxed = parse_and_validate_r3_state_ops(json!({
            "schema": R3_STATE_OPS_SCHEMA, "schemaVersion": 1, "id": "r3", "packageHash": "a".repeat(64),
            "steps": [
                {"atMs": 0, "op": {"kind": "box-enable", "box": {"min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 1.0]}}},
                {"atMs": 10, "op": {"kind": "clip-move", "offset": 1.0}}
            ]
        })).unwrap();
        assert!(
            canonical_r3_state_frame(&boxed, 1, &[])
                .unwrap_err()
                .contains("requires an enabled axis clip")
        );
    }

    #[test]
    fn f32_roundtrip_quantizes_back_onto_the_contract_grid() {
        // The applied-value guarantee: for |v| <= 1000 the f32 rounding error
        // stays below the 5e-4 quantization threshold, so reading the value
        // back through the f32 player state restores the exact contract bytes.
        // Grid values are generated as index*quantum (never accumulated) to
        // avoid drifting off the grid through float addition.
        for index in 1..=1_000_000u64 {
            let value = (index as f64) * QUANTUM;
            let contract = (value / QUANTUM).round() * QUANTUM;
            let f32_value = contract as f32 as f64;
            assert_eq!(
                (f32_value / QUANTUM).round() * QUANTUM,
                contract,
                "quantum round-trip failed at {contract}"
            );
        }
    }
}
