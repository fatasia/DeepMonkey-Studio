//! X 输入边界：保持按键顺序，只合并连续指针移动。
use super::NativeApp;
use deep_engine_native::{
    compat_x::{XEvent, XKey},
    deep2d::LetterboxMapping,
};
use winit::keyboard::KeyCode;

const MAX_EVENTS: usize = 64;

#[derive(Default)]
pub(super) struct InputQueue(Vec<XEvent>);

impl InputQueue {
    pub fn push(&mut self, event: XEvent) -> Result<(), &'static str> {
        if let XEvent::Pointer { x, y } = &event {
            if !x.is_finite() || !y.is_finite() {
                return Err("X pointer must be finite");
            }
            if matches!(self.0.last(), Some(XEvent::Pointer { .. })) {
                *self.0.last_mut().unwrap() = event;
                return Ok(());
            }
        }
        if self.0.len() == MAX_EVENTS {
            return Err("X input queue is full; pending input retained");
        }
        self.0.push(event);
        Ok(())
    }

    pub fn take_or_defaults(&mut self, defaults: &[XEvent]) -> Vec<XEvent> {
        if self.0.is_empty() {
            defaults.to_vec()
        } else {
            std::mem::take(&mut self.0)
        }
    }
}

pub(super) fn key(app: &mut NativeApp, key: KeyCode) -> bool {
    if app.content.active().x_template.is_none() {
        return false;
    }
    let code = match key {
        KeyCode::Enter | KeyCode::NumpadEnter => XKey::Enter,
        KeyCode::ArrowLeft => XKey::ArrowLeft,
        KeyCode::ArrowRight => XKey::ArrowRight,
        // Esc 保留窗口关闭语义，不让内容吞掉宿主退出。
        _ => return false,
    };
    super::x_runtime::input(app, XEvent::Key { code });
    true
}

pub(super) fn pointer(app: &mut NativeApp) {
    if app.content.active().x_template.is_none() {
        return;
    }
    let Some(list) = app
        .content
        .active()
        .deep2d
        .as_ref()
        .map(|content| content.display_list())
    else {
        return;
    };
    let Some(window) = app.window.as_ref() else {
        return;
    };
    let Some(cursor) = app.state.cursor else {
        return;
    };
    let size = window.inner_size();
    if let Some([x, y]) = logical_point(
        [list.logical_width, list.logical_height],
        [size.width, size.height],
        cursor,
    ) {
        super::x_runtime::input(app, XEvent::Pointer { x, y });
    }
}

fn logical_point(logical: [f64; 2], physical: [u32; 2], cursor: [f64; 2]) -> Option<[f64; 2]> {
    if physical.contains(&0) || logical.iter().any(|v| !v.is_finite() || *v <= 0.0) {
        return None;
    }
    let point = LetterboxMapping::new(logical, physical.map(f64::from)).physical_to_logical(cursor);
    (point[0].is_finite()
        && point[1].is_finite()
        && point[0] >= 0.0
        && point[1] >= 0.0
        && point[0] < logical[0]
        && point[1] < logical[1])
        .then_some(point)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pointer(x: f64) -> XEvent {
        XEvent::Pointer { x, y: 2.0 }
    }
    #[test]
    fn movement_coalesces_without_reordering_keys() {
        let mut queue = InputQueue::default();
        queue.push(pointer(1.0)).unwrap();
        queue.push(pointer(2.0)).unwrap();
        let key = XEvent::Key { code: XKey::Enter };
        queue.push(key.clone()).unwrap();
        queue.push(pointer(3.0)).unwrap();
        assert_eq!(
            queue.take_or_defaults(&[]),
            vec![pointer(2.0), key, pointer(3.0)]
        );
        assert!(queue.take_or_defaults(&[]).is_empty());
    }
    #[test]
    fn full_queue_rejects_new_keys_without_losing_pending_input() {
        let mut queue = InputQueue::default();
        for _ in 0..MAX_EVENTS {
            queue
                .push(XEvent::Key {
                    code: XKey::ArrowLeft,
                })
                .unwrap();
        }
        assert!(queue.push(XEvent::Key { code: XKey::Enter }).is_err());
        assert!(queue.push(pointer(f64::NAN)).is_err());
        assert_eq!(queue.take_or_defaults(&[]).len(), MAX_EVENTS);
        assert_eq!(queue.take_or_defaults(&[pointer(4.0)]), vec![pointer(4.0)]);
    }
    #[test]
    fn coordinates_reject_letterbox_margin_edges_and_minimized_windows() {
        assert_eq!(
            logical_point([320.0, 180.0], [640, 480], [320.0, 240.0]),
            Some([160.0, 90.0])
        );
        for cursor in [
            [1.0, 1.0],
            [640.0, 240.0],
            [100.0, 420.0],
            [f64::NAN, 200.0],
        ] {
            assert_eq!(logical_point([320.0, 180.0], [640, 480], cursor), None);
        }
        assert_eq!(logical_point([320.0, 180.0], [0, 480], [0.0, 0.0]), None);
    }

    #[test]
    #[ignore = "requires packaged static CRT X worker"]
    fn queued_input_round_trips_through_real_lpac_worker() {
        use deep_engine_native::compat_x::{
            process::{XProcessConfig, lpac::Session},
            scheduler::{XTickBinding, bind_tick},
            *,
        };
        let mut queue = InputQueue::default();
        queue.push(pointer(1.0)).unwrap();
        queue.push(pointer(42.0)).unwrap();
        queue.push(XEvent::Key { code: XKey::Enter }).unwrap();
        let expected = queue.take_or_defaults(&[]);
        let request = XRequest {
            schema_version: 1,
            expected_epoch: 1,
            started_at_ms: 0,
            random_seed: 1,
            resources: vec![],
            events: vec![
                pointer(0.0),
                XEvent::Key {
                    code: XKey::ArrowLeft,
                },
            ],
            calls: vec![XCall::ReadEvent { index: 0 }, XCall::ReadEvent { index: 1 }],
        };
        let (_, payload) =
            deep_engine_native::runtime_package::freeze_x_resource("x:input", 1, request).unwrap();
        let template: XDynamicContent = serde_json::from_value(payload["content"].clone()).unwrap();
        let content = bind_tick(
            &template,
            XTickBinding {
                epoch: 2,
                started_at_ms: 10,
                random_seed: 2,
                events: expected.clone(),
            },
            XBudget::default(),
        )
        .unwrap();
        let executable = std::env::current_exe().unwrap();
        let worker = executable
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("examples/x_compat_worker.exe");
        let config = XProcessConfig {
            enabled: true,
            ..Default::default()
        };
        let mut session = Session::start(&worker, config).unwrap();
        let context = XExecutionContext {
            current_epoch: 2,
            now_ms: 10,
            cancelled: false,
        };
        let candidate = session.evaluate(&content.request, || context).unwrap();
        let output = XCompatibilityHost::new(true, XBudget::default())
            .unwrap()
            .publish(CompatibilityLane::ExperimentalX, candidate, context)
            .unwrap();
        assert_eq!(
            output,
            expected
                .into_iter()
                .map(XMessage::Event)
                .collect::<Vec<_>>()
        );
        assert!(queue.take_or_defaults(&[]).is_empty());
        session.close().unwrap();
    }
}
