//! Physical content pixels per logical unit already include Windows DPI.
use super::NativeApp;
use deep_engine_native::deep2d::LetterboxMapping;

pub(super) fn effective_scale(app: &NativeApp) -> Option<f64> {
    let size = app.window.as_ref()?.inner_size();
    let list = app.content.active().deep2d.as_ref()?.display_list();
    scale_for(
        [list.logical_width, list.logical_height],
        [size.width, size.height],
    )
}

fn scale_for(logical: [f64; 2], physical: [u32; 2]) -> Option<f64> {
    if physical.contains(&0) || logical.iter().any(|v| !v.is_finite() || *v <= 0.0) {
        return None;
    }
    Some(LetterboxMapping::new(logical, physical.map(f64::from)).scale)
}

pub(super) fn refresh(app: &mut NativeApp) {
    if app.renderer.is_none() {
        return;
    }
    let Some(scale) = effective_scale(app) else {
        return;
    };
    let result = if let Some(dashboard) = app.content.active().dashboard.as_ref() {
        if dashboard.text_scale() == scale {
            return;
        }
        super::dashboard::update(app, |candidate| candidate.set_text_scale(scale)).map(|_| ())
    } else if app.content.active().chart.is_some() && app.content.active().chart_text_scale != scale
    {
        super::chart::refresh_text_scale(app)
    } else {
        Ok(())
    };
    if let Err(error) = result {
        eprintln!("native text density candidate rejected, previous content retained: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn content_ratio_already_includes_dpi_and_letterbox() {
        assert_eq!(scale_for([960.0, 540.0], [1200, 800]), Some(1.25));
        assert_eq!(scale_for([960.0, 540.0], [1440, 810]), Some(1.5));
        assert_eq!(scale_for([960.0, 540.0], [1920, 1080]), Some(2.0));
        assert_eq!(scale_for([960.0, 540.0], [0, 800]), None);
        assert_eq!(scale_for([f64::NAN, 540.0], [1200, 800]), None);
    }
}
