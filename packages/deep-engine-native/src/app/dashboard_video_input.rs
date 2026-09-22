use super::NativeApp;
use deep_engine_native::{
    dashboard_runtime::{dashboard_video_drag_command, dashboard_video_key_command},
    deep2d::LetterboxMapping,
    runtime_package::DashboardRuntimeV1,
};
use winit::keyboard::KeyCode;

const CONTROL_HEIGHT: f64 = 38.0;
const TOGGLE_WIDTH: f64 = 42.0;
const SCRUBBER_LEFT: f64 = 48.0;
const SCRUBBER_RIGHT: f64 = 14.0;

#[derive(Default)]
pub(in crate::app) struct VideoInput {
    focused: Option<String>,
    dragging: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct VideoHit {
    node_id: String,
    frame: [f64; 4],
    action: HitAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HitAction {
    Focus,
    Toggle,
    Scrub,
}

pub(in crate::app) fn press(app: &mut NativeApp) -> bool {
    let Some(point) = logical_cursor(app) else {
        app.dashboard_video_input.focused = None;
        return false;
    };
    let hit = app
        .content
        .active()
        .dashboard
        .as_ref()
        .and_then(|runtime| video_hit(runtime.document(), runtime.active_page_id(), point));
    let Some(hit) = hit else {
        app.dashboard_video_input.focused = None;
        return false;
    };
    app.dashboard_video_input.focused = Some(hit.node_id.clone());
    match hit.action {
        HitAction::Focus => {}
        HitAction::Toggle => {
            control_key(app, &hit.node_id, "Space");
        }
        HitAction::Scrub => {
            app.dashboard_video_input.dragging = Some(hit.node_id.clone());
            scrub(app, &hit.node_id, hit.frame, point[0]);
        }
    }
    true
}

pub(in crate::app) fn pointer(app: &mut NativeApp) -> bool {
    let Some(node_id) = app.dashboard_video_input.dragging.clone() else {
        return false;
    };
    let Some(point) = logical_cursor(app) else {
        return true;
    };
    let frame =
        app.content.active().dashboard.as_ref().and_then(|runtime| {
            video_frame(runtime.document(), runtime.active_page_id(), &node_id)
        });
    if let Some(frame) = frame {
        scrub(app, &node_id, frame, point[0]);
    }
    true
}

pub(in crate::app) fn release(app: &mut NativeApp) {
    app.dashboard_video_input.dragging = None;
}

pub(in crate::app) fn blur(app: &mut NativeApp) {
    app.dashboard_video_input = VideoInput::default();
}

pub(in crate::app) fn key(app: &mut NativeApp, key: KeyCode) -> bool {
    let Some(name) = key_name(key) else {
        return false;
    };
    let Some(node_id) = app.dashboard_video_input.focused.clone() else {
        return false;
    };
    let present = app
        .content
        .active()
        .dashboard
        .as_ref()
        .and_then(|runtime| video_frame(runtime.document(), runtime.active_page_id(), &node_id))
        .is_some();
    if !present {
        app.dashboard_video_input = VideoInput::default();
        return false;
    }
    control_key(app, &node_id, name);
    true
}

fn control_key(app: &mut NativeApp, node_id: &str, name: &str) {
    let Some(command) = dashboard_video_key_command(name, app.input_modifiers.shift_key()) else {
        return;
    };
    control(app, node_id, command);
}

fn scrub(app: &mut NativeApp, node_id: &str, frame: [f64; 4], x: f64) {
    let Some(renderer) = app.renderer.as_ref() else {
        return;
    };
    let Some(duration) = renderer.dashboard_video_duration_100ns(node_id) else {
        return;
    };
    let width = (frame[2] - SCRUBBER_LEFT - SCRUBBER_RIGHT).max(1.0);
    let normalized = (x - frame[0] - SCRUBBER_LEFT) / width;
    match dashboard_video_drag_command(normalized, duration) {
        Ok(command) => control(app, node_id, command),
        Err(error) => app.state.failed(format!("dashboard video scrub: {error}")),
    }
}

fn control(
    app: &mut NativeApp,
    node_id: &str,
    command: deep_engine_native::dashboard_runtime::DashboardVideoCommand,
) {
    let result = app
        .renderer
        .as_mut()
        .ok_or("dashboard video renderer is not ready".to_owned())
        .and_then(|renderer| renderer.control_dashboard_video(node_id, command));
    if let Err(error) = result {
        app.state
            .failed(format!("dashboard video control: {error}"));
    }
}

fn logical_cursor(app: &NativeApp) -> Option<[f64; 2]> {
    let list = app
        .content
        .active()
        .dashboard
        .as_ref()?
        .content()
        .display_list();
    let size = app.window.as_ref()?.inner_size();
    if size.width == 0 || size.height == 0 {
        return None;
    }
    let mapping = LetterboxMapping::new(
        [list.logical_width, list.logical_height],
        [size.width.into(), size.height.into()],
    );
    let point = mapping.physical_to_logical(app.state.cursor?);
    (point[0] >= 0.0
        && point[1] >= 0.0
        && point[0] < list.logical_width
        && point[1] < list.logical_height)
        .then_some(point)
}

fn video_hit(document: &DashboardRuntimeV1, page_id: &str, point: [f64; 2]) -> Option<VideoHit> {
    let videos = document
        .videos
        .iter()
        .map(|video| video.node_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let page = document.pages.iter().find(|page| page.id == page_id)?;
    page.nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| {
            node.visible && videos.contains(node.id.as_str()) && contains(node.frame, point)
        })
        .max_by_key(|(index, node)| (node.z_order, *index))
        .map(|(_, node)| {
            let local_x = point[0] - node.frame[0];
            let local_y = point[1] - node.frame[1];
            let controls_y = (node.frame[3] - CONTROL_HEIGHT).max(0.0);
            let action = if local_y < controls_y {
                HitAction::Focus
            } else if local_x < TOGGLE_WIDTH {
                HitAction::Toggle
            } else {
                HitAction::Scrub
            };
            VideoHit {
                node_id: node.id.clone(),
                frame: node.frame,
                action,
            }
        })
}

fn video_frame(document: &DashboardRuntimeV1, page_id: &str, node_id: &str) -> Option<[f64; 4]> {
    document
        .pages
        .iter()
        .find(|page| page.id == page_id)?
        .nodes
        .iter()
        .find(|node| {
            node.id == node_id
                && node.visible
                && document.videos.iter().any(|video| video.node_id == node.id)
        })
        .map(|node| node.frame)
}

fn contains(frame: [f64; 4], point: [f64; 2]) -> bool {
    point[0] >= frame[0]
        && point[1] >= frame[1]
        && point[0] < frame[0] + frame[2]
        && point[1] < frame[1] + frame[3]
}

fn key_name(key: KeyCode) -> Option<&'static str> {
    match key {
        KeyCode::Space => Some("Space"),
        KeyCode::Enter | KeyCode::NumpadEnter => Some("Enter"),
        KeyCode::ArrowLeft => Some("ArrowLeft"),
        KeyCode::ArrowRight => Some("ArrowRight"),
        KeyCode::Home => Some("Home"),
        KeyCode::End => Some("End"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deep_engine_native::runtime_package::{
        DashboardNode, DashboardPage, DashboardVideoDiagnostic, DashboardVideoPlayback,
        DashboardVideoSource, DashboardVideoState,
    };

    fn document() -> DashboardRuntimeV1 {
        DashboardRuntimeV1 {
            schema: "deep-engine.dashboard-runtime".into(),
            schema_version: 1,
            id: "d".into(),
            revision: 1,
            document_id: "doc".into(),
            document_revision: 1,
            entry_page_id: "p".into(),
            media: vec![],
            text_inputs: vec![],
            text_input: None,
            tables: vec![],
            filter: None,
            videos: vec![DashboardVideoDiagnostic {
                node_id: "video".into(),
                source_node_id: "source".into(),
                source: DashboardVideoSource {
                    uri: None,
                    availability: "missing".into(),
                    packaged: false,
                    resource_id: None,
                },
                playback: DashboardVideoPlayback {
                    fit: "cover".into(),
                    autoplay: false,
                    muted: true,
                    r#loop: false,
                },
                state: DashboardVideoState {
                    status: "blocked".into(),
                    transport: "unavailable".into(),
                    position_seconds: 0.0,
                    duration_seconds: None,
                    reason: "source-missing".into(),
                    missing_capabilities: vec![],
                },
            }],
            pages: vec![DashboardPage {
                id: "p".into(),
                width: 400.0,
                height: 300.0,
                nodes: vec![DashboardNode {
                    id: "video".into(),
                    revision: 1,
                    frame: [20.0, 30.0, 200.0, 120.0],
                    clip: None,
                    z_order: 2,
                    visible: true,
                    hit_id: None,
                    deep2d: None,
                    chart: None,
                    chart_sim: None,
                }],
            }],
        }
    }

    #[test]
    fn hit_routes_body_toggle_and_scrubber_without_claiming_outside_points() {
        let document = document();
        assert_eq!(
            video_hit(&document, "p", [40.0, 50.0]).unwrap().action,
            HitAction::Focus
        );
        assert_eq!(
            video_hit(&document, "p", [40.0, 140.0]).unwrap().action,
            HitAction::Toggle
        );
        assert_eq!(
            video_hit(&document, "p", [120.0, 140.0]).unwrap().action,
            HitAction::Scrub
        );
        assert!(video_hit(&document, "p", [220.0, 150.0]).is_none());
    }

    #[test]
    fn only_declared_visible_video_nodes_are_focusable() {
        let mut document = document();
        document.pages[0].nodes[0].visible = false;
        assert!(video_hit(&document, "p", [40.0, 50.0]).is_none());
        document.pages[0].nodes[0].visible = true;
        document.videos.clear();
        assert!(video_hit(&document, "p", [40.0, 50.0]).is_none());
    }
}
