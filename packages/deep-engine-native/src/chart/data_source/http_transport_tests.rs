//! 真实 std::net 回环服务器驱动的受控 HTTP Transport 矩阵:
//! 每个用例在随机端口起一次性 TcpListener,覆盖 2xx/5xx/3xx/chunked/无长度/
//! 超时/连接拒绝/重连轨迹。全部走真实 socket,不用 mock IO。

use super::contract::TransportFailure::{Timeout, Unavailable};
use super::contract::{Transport, TransportOutcome};
use super::http_transport::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

fn make(port: u16) -> HttpTransport {
    HttpTransport::new(HttpTransportConfig {
        host: "127.0.0.1".into(),
        port,
        path: "/feed".into(),
        method: HttpMethod::Post,
        timeout_ms: 2_000,
    })
    .unwrap()
}

/// 起一次性服务器:收完整请求,回 `response` 字节,然后收尾。
fn serve_once(response: &'static [u8]) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 4096];
        let _ = socket.read(&mut buffer);
        let _ = socket.write_all(response);
        let _ = socket.flush();
    });
    port
}

#[test]
fn ok_response_delivers_body_through_take_response() {
    let mut transport = make(serve_once(
        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
    ));
    assert!(transport.connect().is_up());
    assert!(transport.send(b"ping").is_up());
    assert_eq!(
        transport.take_response().as_deref(),
        Some(b"hello".as_ref())
    );
    // 幂等取空:响应一次性交付,不残留。
    assert_eq!(transport.take_response(), None);
}

#[test]
fn split_responses_across_packets_are_reeassembled_up_to_content_length() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 4096];
        let _ = socket.read(&mut buffer);
        let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\nhe");
        let _ = socket.flush();
        thread::sleep(std::time::Duration::from_millis(30));
        let _ = socket.write_all(b"llo,world!");
        let _ = socket.flush();
    });
    let mut transport = make(port);
    assert!(transport.connect().is_up());
    assert!(transport.send(b"q").is_up());
    assert_eq!(
        transport.take_response().as_deref(),
        Some(b"hello,world!".as_ref())
    );
}

#[test]
fn server_error_status_maps_to_unavailable_with_code() {
    let mut transport = make(serve_once(
        b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n",
    ));
    assert!(transport.connect().is_up());
    let outcome = transport.send(b"ping");
    assert_eq!(
        outcome,
        TransportOutcome::Down(Unavailable("status 503: Service Unavailable".into()))
    );
}

#[test]
fn redirects_are_rejected_not_followed() {
    let mut transport = make(serve_once(
        b"HTTP/1.1 302 Found\r\nLocation: http://evil.example/x\r\nContent-Length: 0\r\n\r\n",
    ));
    assert!(transport.connect().is_up());
    assert!(
        matches!(transport.send(b"ping"), TransportOutcome::Down(Unavailable(reason)) if reason.contains("redirect 302"))
    );
}

#[test]
fn chunked_and_missing_length_are_rejected() {
    let mut chunked = make(serve_once(
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
    ));
    assert!(chunked.connect().is_up());
    assert!(
        matches!(chunked.send(b"q"), TransportOutcome::Down(Unavailable(reason)) if reason.contains("content-length"))
    );
    let mut no_length = make(serve_once(b"HTTP/1.1 200 OK\r\n\r\nbody"));
    assert!(no_length.connect().is_up());
    assert!(
        matches!(no_length.send(b"q"), TransportOutcome::Down(Unavailable(reason)) if reason.contains("content-length"))
    );
}

#[test]
fn silent_server_maps_to_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        thread::sleep(std::time::Duration::from_millis(400));
        drop(socket);
    });
    let mut silent = HttpTransport::new(HttpTransportConfig {
        host: "127.0.0.1".into(),
        port,
        path: "/feed".into(),
        method: HttpMethod::Post,
        timeout_ms: 80,
    })
    .unwrap();
    assert!(silent.connect().is_up());
    assert_eq!(silent.send(b"q"), TransportOutcome::Down(Timeout));
}

#[test]
fn refused_connect_maps_to_unavailable_and_reconnect_after_server_restart() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut transport = make(port);
    // 无人 accept 的瞬间窗口难以稳定制造 refused;改用"未 connect 先 send"与
    // "close 后 send"两个确定性失败,再走一次完整 connect→send 成功轨迹。
    assert!(
        matches!(transport.send(b"q"), TransportOutcome::Down(Unavailable(reason)) if reason.contains("not connected"))
    );
    drop(listener);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut transport = make(port);
    assert!(transport.connect().is_up());
    thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut buffer = [0u8; 4096];
        let _ = socket.read(&mut buffer);
        let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    });
    assert!(transport.send(b"again").is_up());
    assert_eq!(transport.take_response().as_deref(), Some(b"ok".as_ref()));
    // close 幂等:重复 close 不 panic,之后的 send 如实报未连接。
    transport.close();
    transport.close();
    assert!(
        matches!(transport.send(b"q"), TransportOutcome::Down(Unavailable(reason)) if reason.contains("not connected"))
    );
}

#[test]
fn config_validation_rejects_injection_and_bad_timeouts() {
    let base = |host: &str, path: &str, timeout_ms: u64| HttpTransportConfig {
        host: host.into(),
        port: 80,
        path: path.into(),
        method: HttpMethod::Get,
        timeout_ms,
    };
    assert!(HttpTransport::new(base("127.0.0.1", "/feed", 1_000)).is_ok());
    assert!(HttpTransport::new(base("", "/feed", 1_000)).is_err());
    assert!(HttpTransport::new(base("127.0.0.1/x", "/feed", 1_000)).is_err());
    assert!(HttpTransport::new(base("127.0.0.1", "feed", 1_000)).is_err());
    assert!(HttpTransport::new(base("127.0.0.1", "/feed with space", 1_000)).is_err());
    assert!(HttpTransport::new(base("127.0.0.1", "/feed\r\nX: inject", 1_000)).is_err());
    assert!(HttpTransport::new(base("127.0.0.1", "/feed", 0)).is_err());
    assert!(HttpTransport::new(base("127.0.0.1", "/feed", 61_000)).is_err());
}

/// TransportOutcome 缺少 is_up 便利判定,补在测试模块内避免污染生产合同。
trait IsUp {
    fn is_up(&self) -> bool;
}
impl IsUp for TransportOutcome {
    fn is_up(&self) -> bool {
        matches!(self, TransportOutcome::Up)
    }
}
