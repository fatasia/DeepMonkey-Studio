use super::{DashboardVideoColorContract, DashboardVideoPixelFormat, DecodedDashboardVideoFrame};
use std::sync::{Mutex, OnceLock};
use windows::Win32::{
    Media::MediaFoundation::{
        IMFAttributes, IMFByteStream, IMFMediaBuffer, IMFSourceReader, MF_BYTESTREAM_CONTENT_TYPE,
        MF_BYTESTREAM_ORIGIN_NAME, MF_MT_DEFAULT_STRIDE, MF_MT_FRAME_SIZE, MF_MT_MAJOR_TYPE,
        MF_MT_SUBTYPE, MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE, MF_MT_VIDEO_PRIMARIES,
        MF_MT_YUV_MATRIX, MF_PD_DURATION, MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
        MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING,
        MF_SOURCE_READER_FIRST_VIDEO_STREAM, MF_SOURCE_READER_MEDIASOURCE,
        MF_SOURCE_READERF_ENDOFSTREAM, MF_VERSION, MFCreateAttributes,
        MFCreateMFByteStreamOnStreamEx, MFCreateMediaType, MFCreateSourceReaderFromByteStream,
        MFMediaType_Video, MFSTARTUP_FULL, MFShutdown, MFStartup, MFVideoFormat_RGB32,
    },
    System::Com::{
        COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize, IStream, STREAM_SEEK_SET,
        StructuredStorage::CreateStreamOnHGlobal,
    },
};
use windows::core::{HSTRING, Interface};

static MF_LIFETIME: OnceLock<Mutex<usize>> = OnceLock::new();

struct Session {
    com_initialized: bool,
    mf_started: bool,
}

struct BufferLock<'a> {
    buffer: &'a IMFMediaBuffer,
    pointer: *mut u8,
    length: usize,
}

impl<'a> BufferLock<'a> {
    unsafe fn new(buffer: &'a IMFMediaBuffer) -> Result<Self, String> {
        let mut pointer = std::ptr::null_mut();
        let mut length = 0u32;
        unsafe { buffer.Lock(&mut pointer, None, Some(&mut length)) }
            .map_err(|error| format!("lock decoded frame: {error}"))?;
        if pointer.is_null() {
            unsafe {
                let _ = buffer.Unlock();
            }
            return Err("Media Foundation returned a null decoded frame".into());
        }
        Ok(Self {
            buffer,
            pointer,
            length: length as usize,
        })
    }

    fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.pointer, self.length) }
    }
}

impl Drop for BufferLock<'_> {
    fn drop(&mut self) {
        unsafe {
            let _ = self.buffer.Unlock();
        }
    }
}

impl Session {
    fn start() -> Result<Self, String> {
        let mut session = Self {
            com_initialized: false,
            mf_started: false,
        };
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|error| format!("Media Foundation COM init: {error}"))?;
            session.com_initialized = true;
            let mut leases = MF_LIFETIME
                .get_or_init(|| Mutex::new(0))
                .lock()
                .map_err(|_| "Media Foundation lifetime lock poisoned")?;
            if *leases == 0 {
                MFStartup(MF_VERSION, MFSTARTUP_FULL)
                    .map_err(|error| format!("Media Foundation startup: {error}"))?;
            }
            *leases = leases
                .checked_add(1)
                .ok_or("Media Foundation lifetime lease overflow")?;
            session.mf_started = true;
        }
        Ok(session)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            if self.mf_started {
                if let Ok(mut leases) = MF_LIFETIME.get_or_init(|| Mutex::new(0)).lock() {
                    *leases = leases.saturating_sub(1);
                    if *leases == 0 {
                        let _ = MFShutdown();
                    }
                }
            }
            if self.com_initialized {
                CoUninitialize();
            }
        }
    }
}

struct ReaderState {
    _memory_stream: IStream,
    _byte_stream: IMFByteStream,
    reader: IMFSourceReader,
    stream_index: u32,
    width: u32,
    height: u32,
    tight_row: u32,
    source_row: u32,
    stride: i32,
    color: DashboardVideoColorContract,
    duration_100ns: i64,
}

pub(super) struct MediaFoundationVideoDecoder {
    state: ReaderState,
    bytes: Vec<u8>,
    // Fields drop in declaration order; the MF lease and COM apartment must
    // outlive the Source Reader and its byte streams.
    _session: Session,
}

impl MediaFoundationVideoDecoder {
    pub(super) fn new(bytes: Vec<u8>) -> Result<Self, String> {
        let session = Session::start()?;
        let state = unsafe { open(&bytes) }?;
        Ok(Self {
            state,
            bytes,
            _session: session,
        })
    }

    pub(super) fn next_frame(&mut self) -> Result<Option<DecodedDashboardVideoFrame>, String> {
        unsafe { self.state.next_frame() }
    }

    pub(super) fn restart(&mut self) -> Result<(), String> {
        self.state = unsafe { open(&self.bytes) }?;
        Ok(())
    }

    pub(super) fn duration_100ns(&self) -> i64 {
        self.state.duration_100ns
    }

    pub(super) fn seek(&mut self, position_100ns: i64) -> Result<(), String> {
        if position_100ns < 0 || position_100ns > self.state.duration_100ns {
            return Err("dashboard video seek is outside the media duration".into());
        }
        let position =
            windows::Win32::System::Com::StructuredStorage::PROPVARIANT::from(position_100ns);
        let time_format = windows::core::GUID::zeroed();
        unsafe {
            self.state
                .reader
                .SetCurrentPosition(&time_format, &position)
                .map_err(|error| format!("seek packaged MP4 Source Reader: {error}"))?;
        }
        Ok(())
    }
}

unsafe fn open(bytes: &[u8]) -> Result<ReaderState, String> {
    let stream = unsafe { CreateStreamOnHGlobal(Default::default(), true) }
        .map_err(|error| format!("create MP4 memory stream: {error}"))?;
    let mut written = 0u32;
    unsafe {
        stream
            .Write(
                bytes.as_ptr().cast(),
                bytes
                    .len()
                    .try_into()
                    .map_err(|_| "dashboard MP4 exceeds stream write limit")?,
                Some(&mut written),
            )
            .ok()
            .map_err(|error| format!("write MP4 memory stream: {error}"))?;
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|error| format!("rewind MP4 memory stream: {error}"))?;
    }
    if written as usize != bytes.len() {
        return Err("short MP4 memory stream write".into());
    }
    let byte_stream = unsafe { MFCreateMFByteStreamOnStreamEx(&stream) }
        .map_err(|error| format!("wrap MP4 byte stream: {error}"))?;
    let stream_attributes: IMFAttributes = byte_stream
        .cast()
        .map_err(|error| format!("MP4 byte stream attributes: {error}"))?;
    unsafe {
        stream_attributes
            .SetString(&MF_BYTESTREAM_CONTENT_TYPE, &HSTRING::from("video/mp4"))
            .map_err(|error| format!("set MP4 content type: {error}"))?;
        stream_attributes
            .SetString(
                &MF_BYTESTREAM_ORIGIN_NAME,
                &HSTRING::from("packaged-video.mp4"),
            )
            .map_err(|error| format!("set MP4 origin: {error}"))?;
    }

    let mut attributes = None;
    unsafe { MFCreateAttributes(&mut attributes, 2) }
        .map_err(|error| format!("create Source Reader attributes: {error}"))?;
    let attributes = attributes.ok_or("missing Source Reader attributes")?;
    unsafe {
        attributes
            .SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)
            .map_err(|error| format!("enable hardware video transforms: {error}"))?;
        attributes
            .SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)
            .map_err(|error| format!("enable video processing: {error}"))?;
    }
    let reader = unsafe { MFCreateSourceReaderFromByteStream(&byte_stream, &attributes) }
        .map_err(|error| format!("open packaged MP4 Source Reader: {error}"))?;
    let stream_index = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
    let duration = unsafe {
        reader.GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
    }
    .map_err(|error| format!("read packaged MP4 duration: {error}"))?;
    let duration_100ns = match i64::try_from(&duration) {
        Ok(value) => value,
        Err(_) => {
            let value = u64::try_from(&duration)
                .map_err(|error| format!("decode packaged MP4 duration: {error}"))?;
            i64::try_from(value)
                .map_err(|error| format!("packaged MP4 duration exceeds i64: {error}"))?
        }
    };
    if duration_100ns <= 0 {
        return Err("packaged MP4 has invalid duration".into());
    }
    unsafe {
        reader
            .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
            .map_err(|error| format!("disable packaged MP4 streams: {error}"))?;
        reader
            .SetStreamSelection(stream_index, true)
            .map_err(|error| format!("select packaged MP4 video stream: {error}"))?;
    }
    let native_type = unsafe { reader.GetNativeMediaType(stream_index, 0) }
        .map_err(|error| format!("read native video media type: {error}"))?;
    let color = DashboardVideoColorContract {
        source_primaries: unsafe { native_type.GetUINT32(&MF_MT_VIDEO_PRIMARIES) }.ok(),
        source_transfer: unsafe { native_type.GetUINT32(&MF_MT_TRANSFER_FUNCTION) }.ok(),
        source_matrix: unsafe { native_type.GetUINT32(&MF_MT_YUV_MATRIX) }.ok(),
        source_nominal_range: unsafe { native_type.GetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE) }.ok(),
        conversion: "media-foundation-video-processor",
        output_transfer: "srgb",
    };

    let output_type = unsafe { MFCreateMediaType() }
        .map_err(|error| format!("create RGB32 media type: {error}"))?;
    unsafe {
        output_type
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
            .map_err(|error| format!("set RGB32 major type: {error}"))?;
        output_type
            .SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)
            .map_err(|error| format!("set RGB32 subtype: {error}"))?;
        reader
            .SetCurrentMediaType(stream_index, None, &output_type)
            .map_err(|error| format!("negotiate RGB32 output: {error}"))?;
    }
    let current_type = unsafe { reader.GetCurrentMediaType(stream_index) }
        .map_err(|error| format!("read RGB32 media type: {error}"))?;
    let packed_size = unsafe { current_type.GetUINT64(&MF_MT_FRAME_SIZE) }
        .map_err(|error| format!("read decoded frame size: {error}"))?;
    let width = (packed_size >> 32) as u32;
    let height = packed_size as u32;
    let tight_row = width
        .checked_mul(4)
        .ok_or("decoded video row byte overflow")?;
    let stride = unsafe { current_type.GetUINT32(&MF_MT_DEFAULT_STRIDE) }
        .map(|value| value as i32)
        .unwrap_or(tight_row as i32);
    let source_row = stride.unsigned_abs();
    if width == 0 || height == 0 || source_row < tight_row {
        return Err("invalid Media Foundation RGB32 geometry".into());
    }

    Ok(ReaderState {
        _memory_stream: stream,
        _byte_stream: byte_stream,
        reader,
        stream_index,
        width,
        height,
        tight_row,
        source_row,
        stride,
        color,
        duration_100ns,
    })
}

impl ReaderState {
    unsafe fn next_frame(&mut self) -> Result<Option<DecodedDashboardVideoFrame>, String> {
        for _ in 0..128 {
            let mut flags = 0u32;
            let mut timestamp = 0i64;
            let mut sample = None;
            unsafe {
                self.reader
                    .ReadSample(
                        self.stream_index,
                        0,
                        None,
                        Some(&mut flags),
                        Some(&mut timestamp),
                        Some(&mut sample),
                    )
                    .map_err(|error| format!("decode MP4 sample: {error}"))?;
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                return Ok(None);
            }
            let Some(sample) = sample else {
                continue;
            };
            let buffer = unsafe { sample.ConvertToContiguousBuffer() }
                .map_err(|error| format!("make decoded frame contiguous: {error}"))?;
            let locked = unsafe { BufferLock::new(&buffer) }?;
            let source = locked.bytes();
            let required = self.source_row as usize * self.height as usize;
            if source.len() < required {
                return Err("decoded RGB32 buffer is shorter than its stride".into());
            }
            let mut pixels = vec![0u8; self.tight_row as usize * self.height as usize];
            for destination_y in 0..self.height as usize {
                let source_y = if self.stride < 0 {
                    self.height as usize - 1 - destination_y
                } else {
                    destination_y
                };
                let source_start = source_y * self.source_row as usize;
                let destination_start = destination_y * self.tight_row as usize;
                pixels[destination_start..destination_start + self.tight_row as usize]
                    .copy_from_slice(&source[source_start..source_start + self.tight_row as usize]);
            }
            let frame = DecodedDashboardVideoFrame {
                width: self.width,
                height: self.height,
                row_bytes: self.tight_row,
                timestamp_100ns: timestamp,
                pixel_format: DashboardVideoPixelFormat::Bgra8UnormSrgb,
                color: self.color.clone(),
                pixels,
            };
            frame.validate()?;
            return Ok(Some(frame));
        }
        Err("MP4 produced no video frame within the decode budget".into())
    }
}
