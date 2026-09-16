use std::sync::Mutex;

use winit::{
    event::{ElementState, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::ActiveEventLoop,
    keyboard::{KeyCode, PhysicalKey},
    window::WindowId,
};

use deep_engine_native::chart::{
    ChartAction, ChartAxisChannel,
    legend::{LegendAction, LegendFrame},
};
use deep_engine_native::deep2d::LetterboxMapping;
use deep_engine_native::native_ui::chart_a11y::{
    ChartKeyInput, ChartKeyResponse, ChartKeyboardState, LegendCommand, LegendItemSnapshot,
    LegendSnapshot, legend_item_id,
};

use crate::{app_startup::report_presented, events::RenderOutcome, renderer::Renderer};

use super::NativeApp;

use super::{chart, chart_keyboard_smoke, chart_smoke, section_probe, selection_probe};
mod keyboard;
mod redraw;

pub(super) use keyboard::{chart_key, chart_legend_focus};
use redraw::redraw;

pub(super) fn handle(
    app: &mut NativeApp,
    event_loop: &ActiveEventLoop,
    window_id: WindowId,
    event: WindowEvent,
) {
    if app
        .window
        .as_ref()
        .is_none_or(|window| window.id() != window_id)
    {
        return;
    }
    if app.state.verification.is_some()
        && !matches!(
            event,
            WindowEvent::CloseRequested
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::Occluded(_)
                | WindowEvent::RedrawRequested
        )
    {
        return;
    }
    match event {
        WindowEvent::CloseRequested => close(app, event_loop),
        WindowEvent::DroppedFile(path) => app.drop_batch.push(path),
        WindowEvent::HoveredFile(_) => app.drop_batch.hover(),
        WindowEvent::HoveredFileCancelled => app.drop_batch.cancel(),
        WindowEvent::CursorMoved { position, .. } => {
            app.state.cursor = Some([position.x, position.y]);
            super::chart::pointer(app, false);
        }
        WindowEvent::CursorLeft { .. } => {
            app.state.cursor = None;
            super::chart::pointer(app, false);
        }
        WindowEvent::MouseWheel { delta, .. } => {
            let amount = match delta {
                MouseScrollDelta::LineDelta(_, y) => f64::from(y),
                MouseScrollDelta::PixelDelta(position) => position.y,
            };
            super::chart::zoom(app, amount);
        }
        WindowEvent::Ime(event) => super::annotations::ime(app, event),
        WindowEvent::MouseInput {
            state: ElementState::Pressed,
            button: MouseButton::Left,
            ..
        } => {
            if !super::chart::pointer(app, true) {
                super::selection::click(app);
            }
        }
        WindowEvent::Resized(size) => app.resize(size),
        WindowEvent::ScaleFactorChanged { .. } => {
            if let Some(size) = app.window.as_ref().map(|window| window.inner_size()) {
                app.resize(size);
            }
        }
        WindowEvent::Occluded(false) => app.request_redraw(),
        WindowEvent::RedrawRequested => redraw(app, event_loop),
        WindowEvent::KeyboardInput { event, .. }
            if event.state == ElementState::Pressed && !event.repeat =>
        {
            if let PhysicalKey::Code(key) = event.physical_key
                && super::dashboard::key(app, key)
            {
                return;
            }
            if let PhysicalKey::Code(key) = event.physical_key
                && super::annotations::key(app, key, event.text.as_deref())
            {
                return;
            }
            if let PhysicalKey::Code(key) = event.physical_key
                && super::section::key(app, key)
            {
                return;
            }
            if let PhysicalKey::Code(key) = event.physical_key
                && chart_key(app, key)
            {
                return;
            }
            match event.physical_key {
                PhysicalKey::Code(KeyCode::Escape) => close(app, event_loop),
                PhysicalKey::Code(KeyCode::ArrowLeft) => app.rotate(-0.18),
                PhysicalKey::Code(KeyCode::ArrowRight) => app.rotate(0.18),
                PhysicalKey::Code(KeyCode::KeyR) => app.initialize_renderer(),
                PhysicalKey::Code(KeyCode::KeyM) => super::selection::toggle_measurement(app),
                PhysicalKey::Code(KeyCode::Home) => {
                    if !super::chart::reset(app) {
                        super::selection::reset_view(app);
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

fn close(app: &mut NativeApp, event_loop: &ActiveEventLoop) {
    if !super::annotations::preserve(app) {
        return;
    }
    if app.smoke_frame || app.state.verification.is_some() {
        app.state
            .failed("native verification window closed before GPU completion".into());
    }
    event_loop.exit();
}
