//! The title-bar editor has a fixed client-area candidate anchor, not a shaped text caret.
use super::NativeApp;
use winit::dpi::{PhysicalPosition, PhysicalSize};

pub(super) fn refresh(app: &NativeApp, size: PhysicalSize<u32>, scale: f64) {
    if app.state.annotations.draft.is_none() {
        return;
    }
    if let Some(window) = &app.window
        && let Some((position, extent)) = area(size, scale)
    {
        // Physical coordinates use the ScaleFactorChanged payload immediately;
        // winit's Windows backend otherwise converts logical values only once.
        window.set_ime_cursor_area(position, extent);
    }
}

pub(super) fn refresh_current(app: &NativeApp) {
    if let Some(window) = &app.window {
        refresh(app, window.inner_size(), window.scale_factor());
    }
}

fn area(size: PhysicalSize<u32>, scale: f64) -> Option<(PhysicalPosition<u32>, PhysicalSize<u32>)> {
    if size.width == 0 || size.height == 0 || !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let x = ((16.0 * scale).round() as u32).min(size.width - 1);
    let y = ((16.0 * scale).round() as u32).min(size.height - 1);
    let width = ((256.0 * scale).round() as u32).max(1).min(size.width - x);
    let height = ((24.0 * scale).round() as u32).max(1).min(size.height - y);
    Some((
        PhysicalPosition::new(x, y),
        PhysicalSize::new(width, height),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn candidate_anchor_scales_once_and_stays_inside_resized_client() {
        for scale in [1.0, 1.25, 1.5, 2.0, 3.0] {
            let (position, extent) = area(PhysicalSize::new(1280, 720), scale).unwrap();
            assert_eq!(position.x, (16.0 * scale).round() as u32);
            assert_eq!(extent.width, (256.0 * scale).round() as u32);
            for size in [PhysicalSize::new(64, 64), PhysicalSize::new(1, 1)] {
                let (position, extent) = area(size, scale).unwrap();
                assert!(position.x + extent.width <= size.width);
                assert!(position.y + extent.height <= size.height);
                assert!(extent.width > 0 && extent.height > 0);
            }
        }
    }
    #[test]
    fn zero_surface_and_invalid_dpi_do_not_publish_candidate_area() {
        for size in [PhysicalSize::new(0, 720), PhysicalSize::new(1280, 0)] {
            assert!(area(size, 1.0).is_none());
        }
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(area(PhysicalSize::new(1280, 720), scale).is_none());
        }
    }
}
