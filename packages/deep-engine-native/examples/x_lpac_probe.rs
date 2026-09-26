//! 单独的权限负向测试程序，不是XCall执行器，不随产品分发。
#[cfg(windows)]
use serde_json::json;
#[cfg(windows)]
use std::io::Read;
#[cfg(windows)]
fn main() {
    use windows_sys::Win32::Networking::WinSock::{WSACleanup, WSADATA, WSAStartup};
    let mut bytes = String::new();
    std::io::stdin().read_to_string(&mut bytes).unwrap();
    let input: serde_json::Value = serde_json::from_str(&bytes).unwrap();
    if input["mode"] == "sleep" {
        std::thread::sleep(std::time::Duration::from_secs(10));
        return;
    }
    let path = input["canary"].as_str().unwrap();
    let address = input["address"].as_str().unwrap().parse().unwrap();
    let read = std::fs::read(path)
        .err()
        .and_then(|error| error.raw_os_error());
    let write = std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .err()
        .and_then(|error| error.raw_os_error());
    let mut winsock = WSADATA::default();
    let startup = unsafe { WSAStartup(0x0202, &mut winsock) };
    let connect = if startup == 0 {
        std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(500))
            .err()
            .and_then(|error| error.raw_os_error())
    } else {
        None
    };
    if startup == 0 {
        unsafe {
            WSACleanup();
        }
    }
    println!(
        "{}",
        json!({"readError":read,"writeError":write,"startupError":startup,"connectError":connect})
    );
}
#[cfg(not(windows))]
fn main() {}
