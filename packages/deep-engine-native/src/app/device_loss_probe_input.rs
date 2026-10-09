//! Frozen attachment probes accept lifecycle events, without author input changing their fixture.
use super::*;
use winit::event::{DeviceId, ElementState, MouseButton, MouseScrollDelta, TouchPhase};

pub(super) fn fixture_lifecycle(event: &WindowEvent) -> bool {
    matches!(
        event,
        WindowEvent::CloseRequested
            | WindowEvent::Resized(_)
            | WindowEvent::ScaleFactorChanged { .. }
            | WindowEvent::Occluded(_)
            | WindowEvent::RedrawRequested
    )
}

pub(super) fn assert_ignored(probe: &mut Probe, event_loop: &ActiveEventLoop) {
    let window_id = probe.app.window.as_ref().unwrap().id();
    let view = probe.app.state.view;
    let selected = probe.app.state.selected.clone();
    let cursor = probe.app.state.cursor;
    for event in [
        WindowEvent::CursorMoved {
            device_id: DeviceId::dummy(),
            position: winit::dpi::PhysicalPosition::new(960.0, 540.0),
        },
        WindowEvent::MouseInput {
            device_id: DeviceId::dummy(),
            state: ElementState::Pressed,
            button: MouseButton::Left,
        },
        WindowEvent::MouseInput {
            device_id: DeviceId::dummy(),
            state: ElementState::Released,
            button: MouseButton::Left,
        },
        WindowEvent::MouseWheel {
            device_id: DeviceId::dummy(),
            delta: MouseScrollDelta::LineDelta(0.0, 1.0),
            phase: TouchPhase::Moved,
        },
    ] {
        probe.window_event(event_loop, window_id, event);
        assert_eq!(probe.app.state.view, view, "fixture input changed view");
        assert_eq!(
            probe.app.state.selected, selected,
            "fixture input changed selection"
        );
        assert_eq!(
            probe.app.state.cursor, cursor,
            "fixture input reached pointer handler"
        );
    }
}
