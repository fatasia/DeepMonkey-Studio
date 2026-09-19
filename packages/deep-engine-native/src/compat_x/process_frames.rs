//! 一次仅一个在途请求；长度前缀避免等待 EOF，帧预算沿用单次 IPC。
use super::{ipc, XProcessError, MAX_IPC_BYTES};
use std::io::{Read, Write};

pub(super) const SESSION_MAGIC: [u8; 4] = *b"XSF1";
pub(super) const MAX_SESSION_REQUESTS: usize = 1_024;

pub(super) fn read_frame(input: &mut impl Read) -> Result<Option<Vec<u8>>, XProcessError> {
    let mut header = [0; 4];
    loop {
        match input.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(ipc::io_error(error)),
        }
    }
    input.read_exact(&mut header[1..]).map_err(ipc::io_error)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_IPC_BYTES {
        return Err(XProcessError::IpcBudgetExceeded);
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).map_err(ipc::io_error)?;
    Ok(Some(bytes))
}

pub(super) fn write_frame(output: &mut impl Write, bytes: &[u8]) -> Result<(), XProcessError> {
    if bytes.is_empty() || bytes.len() > MAX_IPC_BYTES {
        return Err(XProcessError::IpcBudgetExceeded);
    }
    output
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .map_err(ipc::io_error)?;
    output.write_all(bytes).map_err(ipc::io_error)?;
    output.flush().map_err(ipc::io_error)
}

/// 固定 worker 同时接受旧单次 JSON 与显式 XSF1 会话，内容仍只有封闭 ABI。
pub fn serve_worker(mut input: impl Read, mut output: impl Write) -> Result<(), XProcessError> {
    let mut prefix = [0; 4];
    input.read_exact(&mut prefix).map_err(ipc::io_error)?;
    if prefix != SESSION_MAGIC {
        return ipc::serve(std::io::Cursor::new(prefix).chain(input), output);
    }
    for _ in 0..MAX_SESSION_REQUESTS {
        let Some(bytes) = read_frame(&mut input)? else {
            return Ok(());
        };
        let mut receipt = Vec::new();
        ipc::serve(bytes.as_slice(), &mut receipt)?;
        write_frame(&mut output, &receipt)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_rejects_truncation_and_oversize_before_body_allocation() {
        for bytes in [vec![1], vec![1, 0], vec![1, 0, 0], vec![2, 0, 0, 0, 1]] {
            assert!(read_frame(&mut bytes.as_slice()).is_err());
        }
        for length in [0_u32, (MAX_IPC_BYTES + 1) as u32, u32::MAX] {
            assert_eq!(
                read_frame(&mut length.to_le_bytes().as_slice()),
                Err(XProcessError::IpcBudgetExceeded)
            );
        }
        let mut bytes = Vec::new();
        write_frame(&mut bytes, b"one").unwrap();
        write_frame(&mut bytes, b"two").unwrap();
        let mut input = bytes.as_slice();
        assert_eq!(read_frame(&mut input).unwrap(), Some(b"one".to_vec()));
        assert_eq!(read_frame(&mut input).unwrap(), Some(b"two".to_vec()));
        assert_eq!(read_frame(&mut input).unwrap(), None);
    }
}
