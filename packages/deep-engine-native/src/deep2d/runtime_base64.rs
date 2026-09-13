const INVALID_BASE64: &str = "Expected canonical RFC 4648 base64 without whitespace.";

pub(super) fn decoded_len(value: &str) -> Result<usize, &'static str> {
    let bytes = value.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return Err(INVALID_BASE64);
    }
    let padding = usize::from(bytes.ends_with(b"=")) + usize::from(bytes.ends_with(b"=="));
    for (index, byte) in bytes.iter().copied().enumerate() {
        let in_padding = index >= bytes.len() - padding;
        if byte == b'=' {
            if !in_padding {
                return Err(INVALID_BASE64);
            }
        } else if in_padding || value_of(byte).is_none() {
            return Err(INVALID_BASE64);
        }
    }
    let last = bytes.len() - 4;
    if padding == 2 && value_of(bytes[last + 1]).is_none_or(|value| value & 0x0f != 0) {
        return Err(INVALID_BASE64);
    }
    if padding == 1 && value_of(bytes[last + 2]).is_none_or(|value| value & 0x03 != 0) {
        return Err(INVALID_BASE64);
    }
    Ok(bytes.len() / 4 * 3 - padding)
}

pub(super) fn decode(value: &str) -> Result<Vec<u8>, &'static str> {
    let capacity = decoded_len(value)?;
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(capacity);
    for chunk in bytes.chunks_exact(4) {
        let a = value_of(chunk[0]).ok_or(INVALID_BASE64)? as u32;
        let b = value_of(chunk[1]).ok_or(INVALID_BASE64)? as u32;
        let c = value_of(chunk[2]).unwrap_or(0) as u32;
        let d = value_of(chunk[3]).unwrap_or(0) as u32;
        let packed = (a << 18) | (b << 12) | (c << 6) | d;
        output.push((packed >> 16) as u8);
        if chunk[2] != b'=' {
            output.push((packed >> 8) as u8);
        }
        if chunk[3] != b'=' {
            output.push(packed as u8);
        }
    }
    debug_assert_eq!(output.len(), capacity);
    Ok(output)
}

fn value_of(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_canonical_payloads() {
        assert_eq!(decode("AA==").unwrap(), [0]);
        assert_eq!(decode("AQI=").unwrap(), [1, 2]);
        assert_eq!(decode("AQID").unwrap(), [1, 2, 3]);
    }

    #[test]
    fn rejects_non_canonical_or_misplaced_padding() {
        for value in ["", "A===", "AB==", "AAF=", "AA=A", "AA==\n"] {
            assert!(decoded_len(value).is_err(), "accepted {value:?}");
        }
    }
}
