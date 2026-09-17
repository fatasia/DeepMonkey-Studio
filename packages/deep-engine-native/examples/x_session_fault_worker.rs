//! 持续会话故障夹具，不随产品分发。
use std::io::{Read, Write};
fn main() {
    let mut input = std::io::stdin().lock();
    let mut header = [0; 4];
    input.read_exact(&mut header).unwrap();
    assert_eq!(&header, b"XSF1");
    input.read_exact(&mut header).unwrap();
    let length = u32::from_le_bytes(header) as usize;
    assert!(length <= 4 * 1024 * 1024);
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).unwrap();
    let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    let mut output = std::io::stdout().lock();
    if request["request"]["randomSeed"] == 2 {
        output.write_all(&u32::MAX.to_le_bytes()).unwrap();
    } else {
        output.write_all(&2_u32.to_le_bytes()).unwrap();
        output.write_all(b"{}").unwrap();
    }
    output.flush().unwrap();
    std::thread::sleep(std::time::Duration::from_secs(30));
}
