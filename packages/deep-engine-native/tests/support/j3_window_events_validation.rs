//! Pure CPU lifecycle and host-present receipt validation.
use super::*;

/// 纯 CPU 校验时间线是否符合预注册期望；任何不符返回 Err（不静默降级、不粉饰）。
pub fn validate_window_events(
    timeline: &WindowEventTimeline,
    old_id: u64,
    new_id: u64,
    expectations: &WindowEventExpectations,
) -> Result<WindowEventFindings, String> {
    if let Some(record) = timeline.records().first() {
        if record.kind != WindowEventKind::WindowCreated || record.renderer_id != old_id {
            return Err(format!(
                "expected WindowCreated({old_id}) first, got {record:?}"
            ));
        }
    } else {
        return Err("empty timeline: WindowCreated expected".to_string());
    }
    if old_id == 0 || (expectations.require_recovery_present && (new_id == 0 || new_id == old_id)) {
        return Err("distinct nonzero renderer ids required for window recovery".to_string());
    }
    let mut previous = Duration::ZERO;
    for record in timeline.records() {
        if record.at < previous {
            return Err(format!("non-monotonic window event timeline: {record:?}"));
        }
        previous = record.at;
    }
    let loss = timeline
        .records()
        .iter()
        .filter(|record| record.kind == WindowEventKind::DeviceLostCallback)
        .count() as u32;
    if loss != expectations.loss_callbacks {
        return Err(format!(
            "expected {} lost callbacks, got {loss}",
            expectations.loss_callbacks
        ));
    }
    let mut presents_before_loss = 0usize;
    let mut presents_after_recovery = 0usize;
    let mut recovery_duration = None;
    let mut lost_at = None;
    let mut candidate_id = None;
    for (index, record) in timeline.records().iter().enumerate() {
        match record.kind {
            WindowEventKind::WindowCreated if index != 0 => {
                return Err("duplicate WindowCreated event".to_string());
            }
            WindowEventKind::Presented if lost_at.is_none() => {
                if record.renderer_id != old_id {
                    return Err(format!(
                        "pre-loss present from {}: {record:?}",
                        record.renderer_id
                    ));
                }
                presents_before_loss += 1;
            }
            WindowEventKind::DeviceLostCallback => {
                if record.renderer_id != old_id {
                    return Err(format!(
                        "lost callback id != destroyed {old_id}: {record:?}"
                    ));
                }
                if presents_before_loss == 0 || presents_after_recovery > 0 {
                    return Err("lost callback must follow an old-renderer present and precede recovery present".to_string());
                }
                lost_at.get_or_insert(record.at);
            }
            WindowEventKind::RecoveryCandidateCreated => {
                if lost_at.is_none() || presents_after_recovery > 0 {
                    return Err(
                        "recovery candidate must follow lost callback and precede recovery present"
                            .to_string(),
                    );
                }
                if record.renderer_id == old_id {
                    return Err("recovery candidate must be a new renderer id".to_string());
                }
                if new_id != 0 && record.renderer_id != new_id {
                    return Err(format!(
                        "candidate {} != expected {new_id}",
                        record.renderer_id
                    ));
                }
                candidate_id = Some(record.renderer_id);
            }
            WindowEventKind::RecoveryPresented => {
                if record.renderer_id == old_id {
                    return Err("recovery present must come from the new renderer".to_string());
                }
                if lost_at.is_none()
                    || candidate_id != Some(record.renderer_id)
                    || (new_id != 0 && record.renderer_id != new_id)
                {
                    return Err(
                        "recovery present requires the expected candidate after lost callback"
                            .to_string(),
                    );
                }
                if let Some(lost) = lost_at {
                    recovery_duration.get_or_insert(record.at.saturating_sub(lost));
                }
                presents_after_recovery += 1;
            }
            WindowEventKind::StaleEventRejected => {
                if record.renderer_id != old_id || presents_after_recovery == 0 {
                    return Err(
                        "stale-event rejection must target old renderer after recovery present"
                            .to_string(),
                    );
                }
            }
            WindowEventKind::Presented => {
                return Err(
                    "old Presented event after loss is invalid; use RecoveryPresented".to_string(),
                );
            }
            _ => {}
        }
    }
    if presents_before_loss == 0 {
        return Err("no real present was recorded before the loss".to_string());
    }
    if expectations.require_recovery_present && presents_after_recovery == 0 {
        return Err("recovery present expected but absent".to_string());
    }
    if !expectations.require_recovery_present && presents_after_recovery > 0 {
        return Err("recovery present is forbidden for this expectation".to_string());
    }
    if expectations.require_present_timing {
        let events: Vec<_> = timeline
            .records()
            .iter()
            .filter(|record| {
                matches!(
                    record.kind,
                    WindowEventKind::Presented | WindowEventKind::RecoveryPresented
                )
            })
            .collect();
        if events.len() != timeline.present_samples().len() {
            return Err(
                "present timing must pair exactly with each real Presented event".to_string(),
            );
        }
        for (event, sample) in events.iter().zip(timeline.present_samples()) {
            if sample.duration.is_zero()
                || sample.renderer_id != event.renderer_id
                || sample.at != event.at
                || sample.kind != event.kind
            {
                return Err(
                    "present timing requires positive host span and matching renderer/event/offset"
                        .to_string(),
                );
            }
        }
    }
    let stale_rejections = timeline
        .records()
        .iter()
        .filter(|record| record.kind == WindowEventKind::StaleEventRejected)
        .count() as u32;
    if stale_rejections == 0 {
        return Err("stale-event negative control was not recorded".to_string());
    }
    let total = timeline.elapsed().max(previous);
    if total > expectations.timeout {
        return Err(format!("probe exceeded timeout: {total:?}"));
    }
    Ok(WindowEventFindings {
        presents_before_loss,
        presents_after_recovery,
        loss_callbacks: loss,
        stale_rejections,
        recovery_duration,
        total,
    })
}
