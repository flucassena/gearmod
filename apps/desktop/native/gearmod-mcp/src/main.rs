//! GearMod MCP server (stdio). Runs as a child process of the agent and only talks to the app over a local channel
//! (named pipe on Windows, Unix socket elsewhere) using the execution token. It opens no network port and does not read the database.
//! It is only a relay, the native twin of `resources/gearmod-mcp/server.mjs`: the tool list and every answer come from the app
//! (`src/main/mcp-tools.ts` and `McpBridge`). One JSON line per request; the app answers one JSON line and closes the connection.

use serde_json::{json, Value};
use std::io::{self, BufRead, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

#[cfg(windows)]
fn connect(path: &str) -> io::Result<std::fs::File> {
    // All pipe instances busy (ERROR_PIPE_BUSY = 231): the app creates another one right away, so try again shortly.
    let mut attempt = 0;
    loop {
        match std::fs::OpenOptions::new().read(true).write(true).open(path) {
            Err(error) if error.raw_os_error() == Some(231) && attempt < 50 => {
                attempt += 1;
                thread::sleep(std::time::Duration::from_millis(20));
            }
            other => return other,
        }
    }
}

#[cfg(unix)]
fn connect(path: &str) -> io::Result<std::os::unix::net::UnixStream> {
    std::os::unix::net::UnixStream::connect(path)
}

/// Sends `{token, ...request}` to the app and reads its one-line JSON answer.
fn call_app(socket: &str, token: &str, mut request: Value) -> Result<Value, String> {
    request["token"] = Value::String(token.to_string());
    let mut stream = connect(socket).map_err(|error| error.to_string())?;
    let mut line = request.to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;
    let mut answer = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = stream.read(&mut chunk).map_err(|error| error.to_string())?;
        if read == 0 { break }
        answer.extend_from_slice(&chunk[..read]);
        if answer.contains(&b'\n') { break }
    }
    let end = answer.iter().position(|&byte| byte == b'\n').ok_or_else(|| "the app closed the connection without an answer".to_string())?;
    serde_json::from_slice(&answer[..end]).map_err(|error| error.to_string())
}

fn unreachable(error: &str) -> String { format!("Could not reach GearMod: {error}") }

/// Messages to send back for one JSON-RPC message: the answer (none for notifications, which have no id), followed by
/// `notifications/tools/list_changed` when the call changed the conversation role (e.g. free chat → planning).
fn handle(message: &Value, socket: &str, token: &str) -> Vec<Value> {
    let mut list_changed = false;
    let answer = respond(message, socket, token, &mut list_changed);
    let mut out: Vec<Value> = answer.into_iter().collect();
    if list_changed { out.push(json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" })) }
    out
}

/// Answer to one JSON-RPC message, or None for notifications (no id).
fn respond(message: &Value, socket: &str, token: &str, list_changed: &mut bool) -> Option<Value> {
    let id = message.get("id")?.clone();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let reply = |body: Value| -> Value {
        let mut out = json!({ "jsonrpc": "2.0", "id": id.clone() });
        for (key, value) in body.as_object().cloned().unwrap_or_default() { out[key] = value }
        out
    };
    Some(match method {
        "initialize" => {
            let version = params.get("protocolVersion").cloned().unwrap_or_else(|| json!("2024-11-05"));
            reply(json!({ "result": { "protocolVersion": version, "capabilities": { "tools": { "listChanged": true } }, "serverInfo": { "name": "gearmod", "version": "1.0.0" } } }))
        }
        "ping" => reply(json!({ "result": {} })),
        "tools/list" => match call_app(socket, token, json!({ "list": true })) {
            Ok(answer) if answer["ok"] == json!(true) => reply(json!({ "result": { "tools": answer["tools"] } })),
            Ok(answer) => reply(json!({ "error": { "code": -32603, "message": answer["error"] } })),
            Err(error) => reply(json!({ "error": { "code": -32603, "message": unreachable(&error) } })),
        },
        "tools/call" => {
            let request = json!({ "tool": params.get("name").cloned().unwrap_or(Value::Null), "args": params.get("arguments").cloned().filter(|args| !args.is_null()).unwrap_or_else(|| json!({})) });
            match call_app(socket, token, request) {
                // The app refuses a tool outside the role with the proper notice, never a protocol error; only an unknown name is one.
                Ok(answer) if answer["unknown"] == json!(true) => reply(json!({ "error": { "code": -32602, "message": answer["error"] } })),
                Ok(answer) => {
                    *list_changed = answer["listChanged"] == json!(true);
                    let ok = answer["ok"] == json!(true);
                    let text = if ok { answer["text"].clone() } else { answer["error"].clone() };
                    reply(json!({ "result": { "content": [{ "type": "text", "text": text }], "isError": !ok } }))
                }
                Err(error) => reply(json!({ "result": { "content": [{ "type": "text", "text": unreachable(&error) }], "isError": true } })),
            }
        }
        _ => reply(json!({ "error": { "code": -32601, "message": format!("Unsupported method: {method}") } })),
    })
}

fn main() {
    let (socket, token) = match (std::env::var("GEARMOD_SOCKET"), std::env::var("GEARMOD_TOKEN")) {
        (Ok(socket), Ok(token)) if !socket.is_empty() && !token.is_empty() => (Arc::new(socket), Arc::new(token)),
        _ => {
            eprintln!("GEARMOD_SOCKET and GEARMOD_TOKEN are required");
            std::process::exit(1);
        }
    };
    let stdout = Arc::new(Mutex::new(io::stdout()));
    let mut workers = Vec::new();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };  // invalid line
        let (socket, token, stdout) = (socket.clone(), token.clone(), stdout.clone());
        // Each request in its own thread, like the JavaScript relay: a slow tool (e.g. a commit) does not hold up the others.
        workers.push(thread::spawn(move || {
            let replies = handle(&message, &socket, &token);
            if replies.is_empty() { return }
            let mut out = stdout.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            for reply in replies { let _ = writeln!(out, "{reply}"); }
            let _ = out.flush();
        }));
        workers.retain(|worker| !worker.is_finished());
    }
    for worker in workers { let _ = worker.join(); }
}
