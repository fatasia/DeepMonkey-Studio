//! Native DXR capability probe.
//!
//! Windows D3D12_OPTIONS5 hardware diagnostics, separate from the active
//! renderer device. The default D3D12 adapter may differ from wgpu's selected
//! adapter; this result must not enable rendering features. Production ray
//! queries must use the selected wgpu adapter's EXPERIMENTAL_RAY_QUERY feature.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeRayTracingTier {
    None,
    Pipeline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeRayTracingCapability {
    pub tier: NativeRayTracingTier,
    pub native_dxr: bool,
    pub software_fallback: bool,
}

#[cfg(windows)]
pub fn probe() -> NativeRayTracingCapability {
    use windows::Win32::Graphics::Direct3D::D3D_FEATURE_LEVEL_12_0;
    use windows::Win32::Graphics::Direct3D12::{
        D3D12_FEATURE_D3D12_OPTIONS5, D3D12_FEATURE_DATA_D3D12_OPTIONS5,
        D3D12_RAYTRACING_TIER_NOT_SUPPORTED, D3D12CreateDevice, ID3D12Device,
    };

    unsafe {
        let mut device: Option<ID3D12Device> = None;
        if D3D12CreateDevice(None, D3D_FEATURE_LEVEL_12_0, &mut device).is_err() {
            return unsupported();
        }
        let Some(device) = device else {
            return unsupported();
        };
        let mut options = D3D12_FEATURE_DATA_D3D12_OPTIONS5::default();
        if device
            .CheckFeatureSupport(
                D3D12_FEATURE_D3D12_OPTIONS5,
                &mut options as *mut _ as *mut _,
                std::mem::size_of_val(&options) as u32,
            )
            .is_err()
        {
            return unsupported();
        }
        let enabled = options.RaytracingTier != D3D12_RAYTRACING_TIER_NOT_SUPPORTED;
        NativeRayTracingCapability {
            tier: if enabled {
                NativeRayTracingTier::Pipeline
            } else {
                NativeRayTracingTier::None
            },
            native_dxr: enabled,
            software_fallback: true,
        }
    }
}

#[cfg(not(windows))]
pub fn probe() -> NativeRayTracingCapability {
    unsupported()
}

const fn unsupported() -> NativeRayTracingCapability {
    NativeRayTracingCapability {
        tier: NativeRayTracingTier::None,
        native_dxr: false,
        software_fallback: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fallback_is_always_explicit() {
        assert!(probe().software_fallback);
    }
}
