use std::sync::Mutex;

use winit::{
    event::{ElementState, MouseButton, MouseScrollDelta, TouchPhase, WindowEvent},
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

use super::{
    chart, chart_keyboard_smoke, chart_smoke, dynamic_playback::AfterPresent, section_probe,
    selection_probe, state_ops_playback,
};
mod keyboard;
mod redraw;

#[cfg(windows)]
pub(super) use keyboard::legend_snapshot;
pub(super) use keyboard::{chart_key, chart_legend_focus};
use redraw::redraw;

/// Hidden product windows may not receive an OS `RedrawRequested`. Startup
/// recovery calls the same render transaction from a user event, keeping the
/// window hidden until `RenderOutcome::Presented` publishes it.
pub(super) fn force_startup_redraw(app: &mut NativeApp, event_loop: &ActiveEventLoop) {
    redraw(app, event_loop);
}

/// Studio already coalesces camera input to one event per browser animation
/// frame. Rendering that event immediately avoids scheduling a second web
/// `RedrawRequested` turn while preserving the exact normal redraw transaction.
#[cfg(target_arch = "wasm32")]
pub(super) fn present_wasm_camera(app: &mut NativeApp, event_loop: &ActiveEventLoop) {
    redraw(app, event_loop);
}

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
        WindowEvent::CursorMoved { position, .. } => pointer_move(app, [position.x, position.y]),
        WindowEvent::CursorLeft { .. } => {
            app.state.cursor = None;
            super::chart::pointer(app, false);
        }
        WindowEvent::MouseWheel { delta, .. } => {
            let amount = match delta {
                MouseScrollDelta::LineDelta(_, y) => f64::from(y),
                MouseScrollDelta::PixelDelta(position) => position.y,
            };
            if !super::chart::zoom(app, amount) {
                app.zoom(amount);
            }
        }
        WindowEvent::Ime(event) => {
            if !super::dashboard::ime(app, event.clone()) {
                super::annotations::ime(app, event);
            }
        }
        WindowEvent::ModifiersChanged(modifiers) => app.input_modifiers = modifiers.state(),
        WindowEvent::Focused(focused) => {
            super::annotations::focus(app, focused);
            if !focused {
                app.clear_navigation_input();
                app.input_modifiers = winit::keyboard::ModifiersState::empty();
                super::dashboard::blur(app);
                #[cfg(windows)]
                super::dashboard_video_input::blur(app);
            }
        }
        WindowEvent::MouseInput {
            state: ElementState::Released,
            button: MouseButton::Left,
            ..
        } => pointer_release(app),
        WindowEvent::MouseInput {
            state: ElementState::Pressed,
            button: MouseButton::Left,
            ..
        } => pointer_press(app),
        WindowEvent::Touch(touch) => {
            // 触控统一:触屏单指手势与鼠标左键走完全相同的处理链,
            // 点击、文本聚焦、拖动选区在鼠标/触控/键盘三种输入下语义一致。
            let Some((action, position)) = app.touch_pointer.on_touch(
                touch.id,
                touch.phase,
                [touch.location.x, touch.location.y],
            ) else {
                return;
            };
            match action {
                super::touch_pointer::TouchPointerAction::Press => {
                    // 触控没有独立悬停态:按下先落点(等价 CursorMoved)再触发按下。
                    pointer_move(app, position);
                    pointer_press(app);
                }
                super::touch_pointer::TouchPointerAction::Move => pointer_move(app, position),
                // 取消手势按抬起收尾,pointer_release 只做抬起清理、不产生点击。
                super::touch_pointer::TouchPointerAction::Release
                | super::touch_pointer::TouchPointerAction::Cancel => pointer_release(app),
            }
        }
        WindowEvent::Resized(size) => {
            app.resize(size);
            if let Some(window) = &app.window {
                super::annotation_ime_area::refresh(app, size, window.scale_factor());
                super::dashboard::refresh_input(app);
            }
        }
        WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
            if let Some(size) = app.window.as_ref().map(|window| window.inner_size()) {
                app.resize(size);
                super::annotation_ime_area::refresh(app, size, scale_factor);
                super::dashboard::refresh_input(app);
            }
        }
        WindowEvent::Occluded(false) => app.request_redraw(),
        WindowEvent::RedrawRequested => redraw(app, event_loop),
        WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Released => {
            if let PhysicalKey::Code(key) = event.physical_key
                && app.navigation_key(key, false)
            {
                return;
            }
        }
        WindowEvent::KeyboardInput { event, .. }
            if event.state == ElementState::Pressed && event.repeat =>
        {
            if super::dashboard::text_key(app, &event) {
                return;
            }
            if super::dashboard::select_text_key(app, &event) {
                return;
            }
            if app
                .content
                .active()
                .dashboard
                .as_ref()
                .is_some_and(|runtime| runtime.select_focused())
                && let PhysicalKey::Code(
                    key @ (KeyCode::ArrowUp | KeyCode::ArrowDown | KeyCode::Home | KeyCode::End),
                ) = event.physical_key
            {
                super::dashboard::key(app, key);
            }
        }
        WindowEvent::KeyboardInput { event, .. }
            if event.state == ElementState::Pressed && !event.repeat =>
        {
            if let PhysicalKey::Code(key) = event.physical_key
                && app.navigation_key(key, true)
            {
                return;
            }
            if super::dashboard::text_key(app, &event) {
                return;
            }
            if super::dashboard::select_text_key(app, &event) {
                return;
            }
            if event.physical_key == PhysicalKey::Code(KeyCode::F11)
                && let Some(window) = &app.window
            {
                crate::window_chrome::fullscreen_key(window, KeyCode::F11);
                return;
            }
            #[cfg(windows)]
            if let PhysicalKey::Code(key) = event.physical_key
                && super::x_input::key(app, key)
            {
                return;
            }
            #[cfg(windows)]
            if let PhysicalKey::Code(key) = event.physical_key
                && super::dashboard_video_input::key(app, key)
            {
                return;
            }
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
            if let PhysicalKey::Code(key) = event.physical_key
                && super::camera_views::key(app, key)
            {
                return;
            }
            match event.physical_key {
                PhysicalKey::Code(KeyCode::Escape)
                    if app.window.as_ref().is_some_and(|window| {
                        crate::window_chrome::fullscreen_key(window, KeyCode::Escape)
                    }) => {}
                PhysicalKey::Code(KeyCode::Escape) => close(app, event_loop),
                PhysicalKey::Code(KeyCode::ArrowLeft) => app.rotate(-0.18),
                PhysicalKey::Code(KeyCode::ArrowRight) => app.rotate(0.18),
                PhysicalKey::Code(KeyCode::ArrowUp) => app.tilt(0.12),
                PhysicalKey::Code(KeyCode::ArrowDown) => app.tilt(-0.12),
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

/// 鼠标移动与触控 Move 共用:更新光标并推进悬停与拖动选区。
/// 视频控件声称指针所有权时短路后续路由,与鼠标链行为逐位一致。
fn pointer_move(app: &mut NativeApp, position: [f64; 2]) {
    app.state.cursor = Some(position);
    #[cfg(windows)]
    if super::dashboard_video_input::pointer(app) {
        return;
    }
    #[cfg(windows)]
    super::x_input::pointer(app);
    super::chart::pointer(app, false);
}

/// 鼠标左键按下与触控 Press 共用:视频控件优先,其次图表命中,最后场景拾取。
fn pointer_press(app: &mut NativeApp) {
    #[cfg(windows)]
    if super::dashboard_video_input::press(app) {
        return;
    }
    if !super::chart::pointer(app, true) {
        super::selection::click(app);
    }
}

/// 鼠标左键抬起与触控 Release/Cancel 共用:只做抬起清理,不产生点击。
fn pointer_release(app: &mut NativeApp) {
    #[cfg(windows)]
    super::dashboard_video_input::release(app);
    super::dashboard::release_input(app);
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
