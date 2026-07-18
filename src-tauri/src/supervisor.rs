use std::{
    collections::VecDeque,
    env,
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    time::{Duration, Instant},
};
use std::fmt::Write as _;

use getrandom::getrandom;
use serde::Deserialize;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tokio::time;

const READY_KIND: &str = "gajae-desktop-ready";
const PROTOCOL_VERSION: u32 = 1;
const OUTPUT_LIMIT: usize = 64 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Deserialize)]
struct ReadyFrame {
    kind: String,
    pid: u32,
    host: String,
    port: u16,
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    version: String,
}

#[derive(Debug, Deserialize)]
struct Health {
    status: String,
    product: String,
    #[serde(rename = "protocolVersion")]
    protocol_version: u32,
    version: String,
}

#[derive(Default)]
struct OutputRing {
    bytes: VecDeque<u8>,
}

impl OutputRing {
    fn push(&mut self, output: &[u8]) {
        self.bytes.extend(output);
        while self.bytes.len() > OUTPUT_LIMIT {
            self.bytes.pop_front();
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.iter().copied().collect::<Vec<_>>()).into_owned()
    }
}

fn random_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom(&mut bytes).map_err(|error| format!("could not generate desktop credential: {error}"))?;
    let mut secret = String::with_capacity(64);
    for byte in bytes {
        write!(&mut secret, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(secret)
}

fn payload_root(app: &AppHandle) -> Result<PathBuf, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("could not locate application resources: {error}"))?;
    let root = ["server-payload", "resources/server-payload"]
        .iter()
        .map(|relative| resources.join(relative))
        .find_map(|candidate| candidate.canonicalize().ok())
        .ok_or_else(|| "server payload is missing".to_owned())?;
    for relative in ["dist-server/server/index.js", "dist", "node_modules", "dist-native"] {
        let path = root.join(relative);
        if !path.exists() {
            return Err(format!("server payload is incomplete (missing {})", path.display()));
        }
    }
    if !root.is_dir() {
        return Err("server payload root is not a directory".to_owned());
    }
    Ok(root)
}

fn endpoint(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn health_check(port: u16, expected_version: &str) -> Result<(), String> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().map_err(|error| format!("invalid loopback address: {error}"))?,
        Duration::from_secs(2),
    )
    .map_err(|error| format!("health connection failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| format!("could not set health read timeout: {error}"))?;
    stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .map_err(|error| format!("health request failed: {error}"))?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| format!("health response failed: {error}"))?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| "malformed health response".to_owned())?;
    if !headers.starts_with("HTTP/1.1 200") {
        return Err(format!("health endpoint rejected request: {}", headers.lines().next().unwrap_or_default()));
    }
    let health: Health = serde_json::from_str(body).map_err(|error| format!("invalid health response: {error}"))?;
    if health.status != "ok" || health.product != "gajae-app" || health.protocol_version != PROTOCOL_VERSION || health.version != expected_version {
        return Err("health endpoint identity did not match the supervised server".to_owned());
    }
    Ok(())
}

fn show_error(window: &WebviewWindow, message: &str) {
    let escaped = serde_json::to_string(message).unwrap_or_else(|_| "\"Desktop server failed\"".to_owned());
    let script = format!(
        "document.body.innerHTML = '<main style=\"font:16px system-ui;padding:3rem;max-width:48rem\"><h1>Gajae App could not start</h1><pre style=\"white-space:pre-wrap\"></pre></main>';document.querySelector('pre').textContent={escaped};"
    );
    let _ = window.eval(&script);
    let _ = window.show();
}

fn navigate_and_show(window: &WebviewWindow, port: u16) -> Result<(), String> {
    let url = endpoint(port)
        .parse()
        .map_err(|error| format!("invalid supervised server URL: {error}"))?;
    window.navigate(url).map_err(|error| format!("could not open supervised server: {error}"))?;
    window.show().map_err(|error| format!("could not show main window: {error}"))
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let window = match app.get_webview_window("main") {
            Some(window) => window,
            None => return,
        };
        let payload = match payload_root(&app) {
            Ok(payload) => payload,
            Err(error) => {
                show_error(&window, &error);
                return;
            }
        };
        let api_key = match random_secret() {
            Ok(value) => value,
            Err(error) => {
                show_error(&window, &error);
                return;
            }
        };
        let nonce = match random_secret() {
            Ok(value) => value,
            Err(error) => {
                show_error(&window, &error);
                return;
            }
        };
        let home = env::var("HOME").unwrap_or_default();
        let path = env::var("PATH").unwrap_or_default();
        let entrypoint = payload.join("dist-server/server/index.js");
        let command = app
            .shell()
            .sidecar("gajae-app-server")
            .map_err(|error| format!("could not prepare server sidecar: {error}"))
            .and_then(|command| {
                command
                    .arg(entrypoint.to_string_lossy().as_ref())
                    .env("HOST", "127.0.0.1")
                    .env("SERVER_PORT", "0")
                    .env("NODE_ENV", "production")
                    .env("GJC_DESKTOP", "1")
                    .env("GJC_DESKTOP_API_KEY", api_key)
                    .env("GJC_DESKTOP_BOOTSTRAP_NONCE", nonce)
                    .env("HOME", home)
                    .env("PATH", path)
                    .spawn()
                    .map_err(|error| format!("could not start server sidecar: {error}"))
            });
        let (mut events, _child) = match command {
            Ok(child) => child,
            Err(error) => {
                show_error(&window, &error);
                return;
            }
        };
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        let mut output = OutputRing::default();
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = match time::timeout(remaining, events.recv()).await {
                Ok(Some(event)) => event,
                Ok(None) => break,
                Err(_) => break,
            };
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    output.push(&line);
                    for raw_line in String::from_utf8_lossy(&line).lines() {
                        let Ok(ready) = serde_json::from_str::<ReadyFrame>(raw_line) else { continue };
                        if ready.kind != READY_KIND || ready.pid == 0 || ready.host != "127.0.0.1" || ready.port == 0 || ready.protocol_version != PROTOCOL_VERSION {
                            continue;
                        }
                        match health_check(ready.port, &ready.version) {
                            Ok(()) => {
                                if let Err(error) = navigate_and_show(&window, ready.port) {
                                    show_error(&window, &error);
                                }
                                return;
                            }
                            Err(error) => {
                                show_error(&window, &format!("Desktop server did not pass identity verification: {error}\n\n{}", output.text()));
                                return;
                            }
                        }
                    }
                }
                CommandEvent::Terminated(status) => {
                    show_error(&window, &format!("Desktop server exited unexpectedly ({status:?}).\n\n{}", output.text()));
                    return;
                }
                _ => {}
            }
        }
        show_error(&window, &format!("Desktop server did not become ready before the startup timeout.\n\n{}", output.text()));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_ring_is_bounded() {
        let mut ring = OutputRing::default();
        ring.push(&vec![b'x'; OUTPUT_LIMIT + 1]);
        assert_eq!(ring.bytes.len(), OUTPUT_LIMIT);
    }

    #[test]
    fn ready_frame_requires_loopback_contract() {
        let ready: ReadyFrame = serde_json::from_str(r#"{"kind":"gajae-desktop-ready","pid":1,"host":"127.0.0.1","port":1234,"protocolVersion":1,"version":"0.2.0"}"#).unwrap();
        assert_eq!(ready.kind, READY_KIND);
        assert_eq!(ready.host, "127.0.0.1");
        assert_eq!(ready.protocol_version, PROTOCOL_VERSION);
    }
}
