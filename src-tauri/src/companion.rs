//! LAN / Tailscale companion: the desktop (or `serve` binary) scans local
//! repositories; an iPhone, iPad, or browser fetches the same graph over HTTP.
//!
//! Pairing is a bearer token. Scan paths must canonicalize under a shared
//! root. The graph is the same JSON the desktop exports — structure, import
//! edges, line counts, index summaries — never file contents.

use std::{
    fs,
    io::Read,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use crate::scanner;

pub const PROTOCOL: u32 = 1;
pub const DEFAULT_PORT: u16 = 7420;
const TOKEN_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const MAX_BODY_BYTES: u64 = 64 * 1024;
const MAX_CATALOG_CHILDREN: usize = 200;
const GENERATED_DIRECTORY_NAMES: &[&str] = &[
    ".git",
    ".codebase-index",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    "coverage",
    "vendor",
    "Pods",
    "DerivedData",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub enabled: bool,
    pub port: u16,
    pub token: String,
    pub name: String,
    pub addresses: Vec<CompanionAddress>,
    pub pairing_url: String,
    pub roots: Vec<CompanionRoot>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanionAddress {
    pub url: String,
    pub label: String,
    pub kind: AddressKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AddressKind {
    Lan,
    Tailscale,
    Loopback,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompanionRoot {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct PersistedConfig {
    enabled: bool,
    port: u16,
    token: String,
    roots: Vec<PathBuf>,
}

struct LiveContext {
    token: String,
    name: String,
    roots: Mutex<Vec<PathBuf>>,
    scan_lock: Mutex<()>,
}

struct LiveServer {
    stop: Arc<AtomicBool>,
    thread: thread::JoinHandle<()>,
    bound: SocketAddr,
}

pub struct CompanionControl {
    config_path: PathBuf,
    config: Mutex<PersistedConfig>,
    live: Mutex<Option<LiveServer>>,
    context: Mutex<Option<Arc<LiveContext>>>,
    last_error: Mutex<Option<String>>,
}

#[derive(Debug, Deserialize)]
struct ScanRequest {
    path: String,
}

struct AtlasResponse {
    status: u16,
    body: Vec<u8>,
    content_type: &'static str,
}

impl AtlasResponse {
    fn json(status: u16, value: &impl Serialize) -> Self {
        let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{\"error\":\"serialize\"}".to_vec());
        Self {
            status,
            body,
            content_type: "application/json; charset=utf-8",
        }
    }

    fn error(status: u16, message: &str) -> Self {
        Self::json(status, &serde_json::json!({ "error": message }))
    }
}

/// Random 8-character pairing code.
///
/// # Panics
///
/// Panics if the operating system random source is unavailable.
#[must_use]
pub fn generate_token() -> String {
    let mut bytes = [0u8; 8];
    getrandom::getrandom(&mut bytes).expect("system random source");
    bytes
        .iter()
        .map(|byte| char::from(TOKEN_ALPHABET[usize::from(*byte) % TOKEN_ALPHABET.len()]))
        .collect()
}

pub fn normalize_token(value: &str) -> String {
    value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_uppercase())
        .collect()
}

pub fn pairing_url(token: &str, addresses: &[CompanionAddress]) -> String {
    let token = normalize_token(token);
    let remote: Vec<&CompanionAddress> = addresses
        .iter()
        .filter(|address| address.kind != AddressKind::Loopback)
        .collect();
    let used = if remote.is_empty() {
        addresses.iter().collect()
    } else {
        remote
    };
    let mut url = format!("codebase-atlas://pair?v=1&t={token}");
    for address in used {
        let host = address
            .url
            .strip_prefix("http://")
            .or_else(|| address.url.strip_prefix("https://"))
            .unwrap_or(&address.url)
            .trim_end_matches('/');
        url.push_str("&h=");
        url.push_str(host);
    }
    url
}

fn print_pairing_qr(url: &str) {
    let Ok(code) = qrcode::QrCode::new(url.as_bytes()) else {
        return;
    };
    println!();
    println!(
        "{}",
        code.render::<qrcode::render::unicode::Dense1x2>()
            .quiet_zone(true)
            .build()
    );
}

pub fn display_token(token: &str) -> String {
    if token.len() == 8 {
        format!("{}-{}", &token[..4], &token[4..])
    } else {
        token.to_owned()
    }
}

pub fn host_name() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|name| name.trim().trim_end_matches(".local").to_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Codebase Atlas".to_owned())
}

pub fn advertised_addresses(port: u16) -> Vec<CompanionAddress> {
    let mut addresses = Vec::new();
    let name = host_name();
    if name != "Codebase Atlas" {
        let kind = if name.ends_with(".ts.net") {
            AddressKind::Tailscale
        } else {
            AddressKind::Lan
        };
        let host = if name.contains('.') {
            name.clone()
        } else {
            format!("{name}.local")
        };
        addresses.push(CompanionAddress {
            url: format!("http://{host}:{port}"),
            label: host,
            kind,
        });
    }

    if let Ok(ifaces) = if_addrs::get_if_addrs() {
        for iface in ifaces {
            let std::net::IpAddr::V4(ip) = iface.ip() else {
                continue;
            };
            let Some(kind) = classify_ipv4(ip) else {
                continue;
            };
            let url = format!("http://{ip}:{port}");
            if addresses.iter().any(|address| address.url == url) {
                continue;
            }
            addresses.push(CompanionAddress {
                label: match kind {
                    AddressKind::Tailscale => format!("Tailscale {ip}"),
                    AddressKind::Lan => format!("Wi-Fi {ip}"),
                    AddressKind::Loopback => format!("This computer {ip}"),
                },
                url,
                kind,
            });
        }
    }

    addresses.sort_by_key(|address| match address.kind {
        AddressKind::Lan => 0,
        AddressKind::Tailscale => 1,
        AddressKind::Loopback => 2,
    });
    addresses
}

fn classify_ipv4(ip: Ipv4Addr) -> Option<AddressKind> {
    if ip.is_loopback() {
        Some(AddressKind::Loopback)
    } else if is_tailscale(ip) {
        Some(AddressKind::Tailscale)
    } else if ip.is_private() {
        Some(AddressKind::Lan)
    } else {
        None
    }
}

fn is_tailscale(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..128).contains(&octets[1])
}

fn folder_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.to_string_lossy().into_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

fn looks_like_project(path: &Path) -> bool {
    path.join(".git").exists()
        || path.join("package.json").exists()
        || path.join("Cargo.toml").exists()
        || path.join("pyproject.toml").exists()
        || path.join("go.mod").exists()
        || path.join("Package.swift").exists()
        || has_suffix_child(path, "xcodeproj")
        || has_suffix_child(path, "xcworkspace")
}

fn has_suffix_child(path: &Path, extension: &str) -> bool {
    fs::read_dir(path).ok().is_some_and(|entries| {
        entries.flatten().any(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|value| value == extension)
        })
    })
}

fn is_skippable_directory(name: &str) -> bool {
    name.starts_with('.') || GENERATED_DIRECTORY_NAMES.contains(&name)
}

pub(crate) fn catalog_entries(roots: &[PathBuf]) -> Vec<CompanionRoot> {
    let mut entries = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for root in roots {
        for entry in expand_root(root) {
            if seen.insert(entry.path.clone()) {
                entries.push(entry);
            }
        }
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    entries
}

fn expand_root(root: &Path) -> Vec<CompanionRoot> {
    let root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut entries = vec![CompanionRoot {
        name: folder_name(&root),
        path: root.to_string_lossy().into_owned(),
    }];
    if root.join(".git").exists() {
        return entries;
    }
    let Ok(read) = fs::read_dir(root) else {
        return entries;
    };
    let mut children: Vec<PathBuf> = read
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| !is_skippable_directory(name))
        })
        .filter(|path| looks_like_project(path))
        .collect();
    children.sort();
    children.truncate(MAX_CATALOG_CHILDREN);
    for child in children {
        entries.push(CompanionRoot {
            name: folder_name(&child),
            path: child.to_string_lossy().into_owned(),
        });
    }
    entries
}

pub(crate) fn allowed_path(roots: &[PathBuf], requested: &Path) -> Result<PathBuf, String> {
    let canonical = scanner::canonical_root(requested)?;
    let allowed = roots.iter().any(|root| {
        let Ok(root) = fs::canonicalize(root) else {
            return false;
        };
        canonical == root || canonical.starts_with(&root)
    });
    if allowed {
        Ok(canonical)
    } else {
        Err("That folder is not shared on this computer.".to_owned())
    }
}

fn handle_request(
    context: &LiveContext,
    method: &str,
    path: &str,
    authorization: Option<&str>,
    body: &[u8],
) -> AtlasResponse {
    let path = path.split('?').next().unwrap_or(path);
    match (method, path) {
        ("GET", "/v1/health") => health(context),
        ("GET", "/v1/catalog") => {
            if let Err(response) = authorize(context, authorization) {
                return response;
            }
            catalog(context)
        }
        ("POST", "/v1/scan") => {
            if let Err(response) = authorize(context, authorization) {
                return response;
            }
            scan(context, body)
        }
        _ => AtlasResponse::error(404, "Unknown companion route."),
    }
}

fn health(context: &LiveContext) -> AtlasResponse {
    AtlasResponse::json(
        200,
        &serde_json::json!({
            "protocol": PROTOCOL,
            "app": "codebase-atlas",
            "name": context.name,
        }),
    )
}

fn authorize(context: &LiveContext, authorization: Option<&str>) -> Result<(), AtlasResponse> {
    let presented = authorization
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(normalize_token)
        .filter(|value| !value.is_empty());
    if presented.as_deref() == Some(context.token.as_str()) {
        Ok(())
    } else {
        Err(AtlasResponse::error(401, "Pairing code did not match."))
    }
}

fn catalog(context: &LiveContext) -> AtlasResponse {
    let roots = context.roots.lock().map_or_else(
        |_| Vec::new(),
        |guard| guard.clone(),
    );
    AtlasResponse::json(
        200,
        &serde_json::json!({
            "protocol": PROTOCOL,
            "name": context.name,
            "repositories": catalog_entries(&roots),
        }),
    )
}

fn scan(context: &LiveContext, body: &[u8]) -> AtlasResponse {
    let Ok(request) = serde_json::from_slice::<ScanRequest>(body) else {
        return AtlasResponse::error(400, "Send a JSON object with a folder path.");
    };
    if request.path.trim().is_empty() {
        return AtlasResponse::error(400, "Send a JSON object with a folder path.");
    }
    let roots = context.roots.lock().map_or_else(
        |_| Vec::new(),
        |guard| guard.clone(),
    );
    let path = match allowed_path(&roots, Path::new(&request.path)) {
        Ok(path) => path,
        Err(message) => {
            let status = if message.contains("does not exist") { 404 } else { 403 };
            return AtlasResponse::error(status, &message);
        }
    };
    let _scan = context.scan_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    match scanner::scan_repository_path(&path) {
        Ok(graph) => AtlasResponse::json(200, &graph),
        Err(message) => AtlasResponse::error(400, &message),
    }
}

fn cors_headers() -> Vec<Header> {
    [
        "Access-Control-Allow-Origin: *",
        "Access-Control-Allow-Headers: Authorization, Content-Type",
        "Access-Control-Allow-Methods: GET, POST, OPTIONS",
        "Access-Control-Max-Age: 600",
    ]
    .into_iter()
    .map(|header| header.parse::<Header>().expect("static CORS header"))
    .collect()
}

fn respond(request: Request, atlas: AtlasResponse) {
    let mut response = Response::from_data(atlas.body).with_status_code(StatusCode(atlas.status));
    let content_type =
        format!("Content-Type: {}", atlas.content_type).parse::<Header>().expect("content type");
    response = response.with_header(content_type);
    for header in cors_headers() {
        response = response.with_header(header);
    }
    let _ = request.respond(response);
}

fn request_method(request: &Request) -> String {
    request.method().as_str().to_owned()
}

fn request_authorization(request: &Request) -> Option<String> {
    request.headers().iter().find_map(|header| {
        if header.field.equiv("Authorization") {
            Some(header.value.as_str().to_owned())
        } else {
            None
        }
    })
}

fn serve_request(context: &LiveContext, mut request: Request) {
    if *request.method() == Method::Options {
        let response = Response::empty(204);
        let mut response = response;
        for header in cors_headers() {
            response = response.with_header(header);
        }
        let _ = request.respond(response);
        return;
    }

    let method = request_method(&request);
    let path = request.url().to_owned();
    let authorization = request_authorization(&request);
    let mut body = Vec::new();
    let _ = request.as_reader().take(MAX_BODY_BYTES).read_to_end(&mut body);
    let atlas = handle_request(
        context,
        &method,
        &path,
        authorization.as_deref(),
        &body,
    );
    respond(request, atlas);
}

fn start_on(addr: SocketAddr, context: Arc<LiveContext>, stop: Arc<AtomicBool>) -> Result<LiveServer, String> {
    let server = Server::http(addr).map_err(|error| format!("Could not listen on {addr}: {error}"))?;
    let bound = server_socket(&server)?;
    let thread_stop = Arc::clone(&stop);
    let thread = thread::spawn(move || {
        for request in server.incoming_requests() {
            if thread_stop.load(Ordering::SeqCst) {
                break;
            }
            let context = Arc::clone(&context);
            thread::spawn(move || serve_request(&context, request));
        }
    });
    Ok(LiveServer { stop, thread, bound })
}

fn server_socket(server: &Server) -> Result<SocketAddr, String> {
    server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "Companion server bound a non-IP address.".to_owned())
}

fn wakeup_addr(bound: SocketAddr) -> SocketAddr {
    if bound.ip().is_unspecified() {
        SocketAddr::new(Ipv4Addr::LOCALHOST.into(), bound.port())
    } else {
        bound
    }
}

fn stop_server(live: LiveServer) {
    live.stop.store(true, Ordering::SeqCst);
    if let Ok(mut stream) =
        std::net::TcpStream::connect_timeout(&wakeup_addr(live.bound), Duration::from_millis(400))
    {
        use std::io::Write;
        let _ = stream.write_all(
            b"GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
        let _ = stream.shutdown(std::net::Shutdown::Write);
    }
    let _ = live.thread.join();
}

impl Default for PersistedConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            token: generate_token(),
            roots: Vec::new(),
        }
    }
}

impl CompanionControl {
    pub fn load(config_path: PathBuf) -> Self {
        let config = fs::read(&config_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<PersistedConfig>(&bytes).ok())
            .map(|mut config| {
                config.token = normalize_token(&config.token);
                if config.token.is_empty() {
                    config.token = generate_token();
                }
                if config.port == 0 {
                    config.port = DEFAULT_PORT;
                }
                config
            })
            .unwrap_or_default();
        Self {
            config_path,
            config: Mutex::new(config),
            live: Mutex::new(None),
            context: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }

    fn persist(&self) {
        let Ok(config) = self.config.lock() else {
            return;
        };
        if let Some(parent) = self.config_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(&*config) {
            let _ = fs::write(&self.config_path, bytes);
        }
    }

    fn with_config_mut(&self, update: impl FnOnce(&mut PersistedConfig)) {
        if let Ok(mut config) = self.config.lock() {
            update(&mut config);
        }
        self.persist();
    }

    pub fn status(&self) -> CompanionStatus {
        let config = self.config.lock().expect("companion config").clone();
        let error = self.last_error.lock().ok().and_then(|guard| guard.clone());
        let addresses = advertised_addresses(config.port);
        CompanionStatus {
            enabled: config.enabled && self.live.lock().ok().is_some_and(|guard| guard.is_some()),
            port: config.port,
            token: display_token(&config.token),
            name: host_name(),
            pairing_url: pairing_url(&config.token, &addresses),
            addresses,
            roots: config
                .roots
                .iter()
                .map(|path| CompanionRoot {
                    name: folder_name(path),
                    path: path.to_string_lossy().into_owned(),
                })
                .collect(),
            error,
        }
    }

    pub fn remember_root(&self, path: &Path) {
        let Ok(canonical) = scanner::canonical_root(path) else {
            return;
        };
        self.with_config_mut(|config| {
            if !config.roots.contains(&canonical) {
                config.roots.push(canonical.clone());
            }
        });
        if let Ok(context) = self.context.lock() {
            if let Some(context) = context.as_ref() {
                if let Ok(mut roots) = context.roots.lock() {
                    if !roots.contains(&canonical) {
                        roots.push(canonical);
                    }
                }
            }
        }
    }

    pub fn forget_root(&self, path: &Path) {
        let requested = path.to_path_buf();
        self.with_config_mut(|config| {
            config.roots.retain(|root| *root != requested);
        });
        if let Ok(context) = self.context.lock() {
            if let Some(context) = context.as_ref() {
                if let Ok(mut roots) = context.roots.lock() {
                    roots.retain(|root| *root != requested);
                }
            }
        }
    }

    pub fn start(&self) -> Result<CompanionStatus, String> {
        self.stop_live();
        let config = self.config.lock().expect("companion config").clone();
        let context = Arc::new(LiveContext {
            token: config.token.clone(),
            name: host_name(),
            roots: Mutex::new(config.roots.clone()),
            scan_lock: Mutex::new(()),
        });
        let stop = Arc::new(AtomicBool::new(false));
        let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, config.port));
        match start_on(addr, Arc::clone(&context), stop) {
            Ok(live) => {
                *self.context.lock().expect("companion context") = Some(context);
                *self.live.lock().expect("companion server") = Some(live);
                *self.last_error.lock().expect("companion error") = None;
                self.with_config_mut(|config| config.enabled = true);
                Ok(self.status())
            }
            Err(error) => {
                self.set_last_error(error.clone());
                Err(error)
            }
        }
    }

    fn stop_live(&self) {
        if let Some(live) = self.live.lock().expect("companion server").take() {
            stop_server(live);
        }
        *self.context.lock().expect("companion context") = None;
    }

    pub fn stop(&self) {
        self.stop_live();
        self.with_config_mut(|config| config.enabled = false);
        *self.last_error.lock().expect("companion error") = None;
    }

    pub fn set_last_error(&self, error: String) {
        *self.last_error.lock().expect("companion error") = Some(error);
    }
}

/// Blocking companion used by the `serve` binary. Runs until the process is killed.
///
/// # Errors
///
/// Returns a user-facing message when a shared folder cannot be opened or the port is already in use.
pub fn serve_blocking(port: u16, token: &str, roots: Vec<PathBuf>) -> Result<(), String> {
    let token = {
        let normalized = normalize_token(token);
        if normalized.is_empty() {
            generate_token()
        } else {
            normalized
        }
    };
    let mut canonical_roots = Vec::new();
    for root in roots {
        canonical_roots.push(scanner::canonical_root(&root)?);
    }
    if canonical_roots.is_empty() {
        canonical_roots.push(scanner::canonical_root(Path::new("."))?);
    }
    let context = Arc::new(LiveContext {
        token: token.clone(),
        name: host_name(),
        roots: Mutex::new(canonical_roots.clone()),
        scan_lock: Mutex::new(()),
    });
    let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
    let _live = start_on(addr, context, Arc::new(AtomicBool::new(false)))?;
    let addresses = advertised_addresses(port);
    let url = pairing_url(&token, &addresses);
    println!("Codebase Atlas companion");
    println!("  Protocol      {PROTOCOL}");
    println!("  Pairing code  {}", display_token(&token));
    for address in &addresses {
        println!("  {:<13} {}", address.label, address.url);
    }
    for root in &canonical_roots {
        println!("  Shared        {}", root.display());
    }
    println!("  Pairing URL   {url}");
    print_pairing_qr(&url);
    println!();
    println!("On iPhone, open Camera and scan this code — or Scan inside Codebase Atlas.");
    println!("Wi-Fi and Tailscale both work; the tunnel encrypts Tailscale hops.");
    println!("Press Ctrl+C to stop.");
    loop {
        thread::park();
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::Manager;
    let dir = app.path().app_config_dir()?;
    fs::create_dir_all(&dir)?;
    let control = CompanionControl::load(dir.join("companion.json"));
    let should_start = control.config.lock().is_ok_and(|config| config.enabled);
    if should_start {
        if let Err(error) = control.start() {
            control.set_last_error(error);
        }
    }
    app.manage(control);
    Ok(())
}

#[allow(
    clippy::needless_pass_by_value,
    clippy::unnecessary_wraps,
    clippy::missing_errors_doc
)]
#[tauri::command]
pub fn start_companion(
    control: tauri::State<CompanionControl>,
    extra_root: Option<String>,
) -> Result<CompanionStatus, String> {
    if let Some(path) = extra_root {
        control.remember_root(Path::new(&path));
    }
    control.start()
}

#[allow(
    clippy::needless_pass_by_value,
    clippy::unnecessary_wraps,
    clippy::missing_errors_doc
)]
#[tauri::command]
pub fn stop_companion(control: tauri::State<CompanionControl>) -> Result<CompanionStatus, String> {
    control.stop();
    Ok(control.status())
}

#[allow(
    clippy::needless_pass_by_value,
    clippy::unnecessary_wraps,
    clippy::missing_errors_doc
)]
#[tauri::command]
pub fn companion_status(control: tauri::State<CompanionControl>) -> Result<CompanionStatus, String> {
    Ok(control.status())
}

#[allow(
    clippy::needless_pass_by_value,
    clippy::unnecessary_wraps,
    clippy::missing_errors_doc
)]
#[tauri::command]
pub fn share_companion_root(
    control: tauri::State<CompanionControl>,
    path: String,
) -> Result<CompanionStatus, String> {
    control.remember_root(Path::new(&path));
    Ok(control.status())
}

#[allow(
    clippy::needless_pass_by_value,
    clippy::unnecessary_wraps,
    clippy::missing_errors_doc
)]
#[tauri::command]
pub fn unshare_companion_root(
    control: tauri::State<CompanionControl>,
    path: String,
) -> Result<CompanionStatus, String> {
    control.forget_root(Path::new(&path));
    Ok(control.status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn context_with_roots(roots: Vec<PathBuf>) -> LiveContext {
        LiveContext {
            token: "ABCD2345".to_owned(),
            name: "Test Host".to_owned(),
            roots: Mutex::new(roots),
            scan_lock: Mutex::new(()),
        }
    }

    fn json_body(response: &AtlasResponse) -> serde_json::Value {
        serde_json::from_slice(&response.body).expect("json body")
    }

    #[test]
    fn pairing_codes_ignore_hyphens_and_case() {
        assert_eq!(normalize_token("k7m2-q9xp"), "K7M2Q9XP");
        assert_eq!(display_token("K7M2Q9XP"), "K7M2-Q9XP");
    }

    #[test]
    fn pairing_url_lists_lan_and_tailscale_hosts() {
        let url = pairing_url(
            "abcd-2345",
            &[
                CompanionAddress {
                    url: "http://127.0.0.1:7420".into(),
                    label: "loopback".into(),
                    kind: AddressKind::Loopback,
                },
                CompanionAddress {
                    url: "http://192.168.1.12:7420".into(),
                    label: "wifi".into(),
                    kind: AddressKind::Lan,
                },
                CompanionAddress {
                    url: "http://100.64.1.20:7420".into(),
                    label: "tailscale".into(),
                    kind: AddressKind::Tailscale,
                },
            ],
        );
        assert_eq!(
            url,
            "codebase-atlas://pair?v=1&t=ABCD2345&h=192.168.1.12:7420&h=100.64.1.20:7420"
        );
    }

    #[test]
    fn tailscale_cgnat_addresses_are_detected() {
        assert_eq!(
            classify_ipv4(Ipv4Addr::new(100, 64, 0, 1)),
            Some(AddressKind::Tailscale)
        );
        assert_eq!(
            classify_ipv4(Ipv4Addr::new(100, 127, 1, 2)),
            Some(AddressKind::Tailscale)
        );
        assert_eq!(
            classify_ipv4(Ipv4Addr::new(192, 168, 1, 20)),
            Some(AddressKind::Lan)
        );
        assert_eq!(classify_ipv4(Ipv4Addr::new(8, 8, 8, 8)), None);
    }

    #[test]
    fn catalog_lists_a_git_root_as_one_repository() {
        let dir = tempdir().expect("temp");
        fs::create_dir_all(dir.path().join(".git")).expect("git");
        fs::create_dir_all(dir.path().join("src")).expect("src");
        fs::write(dir.path().join("src/lib.rs"), "fn x() {}\n").expect("src file");
        let entries = catalog_entries(&[dir.path().to_path_buf()]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, folder_name(dir.path()));
    }

    #[test]
    fn catalog_expands_a_folder_of_projects() {
        let dir = tempdir().expect("temp");
        fs::create_dir_all(dir.path().join("atlas/.git")).expect("atlas git");
        fs::create_dir_all(dir.path().join("notes")).expect("notes");
        fs::write(dir.path().join("notes/readme.md"), "hi\n").expect("notes file");
        fs::create_dir_all(dir.path().join("engine")).expect("engine");
        fs::write(dir.path().join("engine/Cargo.toml"), "[package]\nname = \"engine\"\n")
            .expect("engine manifest");
        let entries = catalog_entries(&[dir.path().to_path_buf()]);
        let names: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(names.contains(&folder_name(dir.path()).as_str()));
        assert!(names.contains(&"atlas"));
        assert!(names.contains(&"engine"));
        assert!(!names.contains(&"notes"));
    }

    #[test]
    fn allowlist_rejects_paths_outside_shared_roots() {
        let dir = tempdir().expect("temp");
        let shared = dir.path().join("shared");
        let secret = dir.path().join("secret");
        fs::create_dir_all(&shared).expect("shared");
        fs::create_dir_all(&secret).expect("secret");
        let roots = vec![shared.clone()];
        assert!(allowed_path(&roots, &shared).is_ok());
        assert!(allowed_path(&roots, &secret).is_err());
        let escape = shared.join("..").join("secret");
        assert!(allowed_path(&roots, &escape).is_err());
    }

    #[test]
    fn health_does_not_need_a_token() {
        let context = context_with_roots(Vec::new());
        let response = handle_request(&context, "GET", "/v1/health", None, b"");
        assert_eq!(response.status, 200);
        let body = json_body(&response);
        assert_eq!(body["protocol"], PROTOCOL);
        assert_eq!(body["name"], "Test Host");
    }

    #[test]
    fn catalog_requires_the_pairing_code() {
        let context = context_with_roots(Vec::new());
        let denied = handle_request(&context, "GET", "/v1/catalog", None, b"");
        assert_eq!(denied.status, 401);
        let allowed = handle_request(
            &context,
            "GET",
            "/v1/catalog",
            Some("Bearer abcd-2345"),
            b"",
        );
        assert_eq!(allowed.status, 200);
        assert_eq!(json_body(&allowed)["repositories"], serde_json::json!([]));
    }

    #[test]
    fn scan_returns_a_local_graph_for_a_shared_root() {
        let dir = tempdir().expect("temp");
        fs::write(dir.path().join("README.md"), "# atlas\n").expect("readme");
        let context = context_with_roots(vec![dir.path().to_path_buf()]);
        let body = serde_json::json!({ "path": dir.path() }).to_string();
        let response = handle_request(
            &context,
            "POST",
            "/v1/scan",
            Some("Bearer ABCD2345"),
            body.as_bytes(),
        );
        assert_eq!(response.status, 200);
        let graph = json_body(&response);
        assert_eq!(graph["source"], "local");
        assert_eq!(graph["stats"]["importsAvailable"], true);
        assert_eq!(graph["stats"]["lineCountAvailable"], true);
    }

    #[test]
    fn companion_round_trip_over_loopback_http() {
        let dir = tempdir().expect("temp");
        fs::write(dir.path().join("lib.rs"), "pub fn x() {}\n").expect("lib");
        let context = Arc::new(context_with_roots(vec![dir.path().to_path_buf()]));
        let stop = Arc::new(AtomicBool::new(false));
        let live = start_on(
            SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            context,
            Arc::clone(&stop),
        )
        .expect("listen");
        let url_host = live.bound;
        let health = raw_http(
            url_host,
            "GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
        );
        assert!(health.contains("\"protocol\":1"), "{health}");
        let catalog = raw_http(
            url_host,
            "GET /v1/catalog HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ABCD2345\r\nConnection: close\r\n\r\n",
        );
        assert!(catalog.contains(&folder_name(dir.path())), "{catalog}");
        stop_server(live);
    }

    fn raw_http(addr: SocketAddr, request: &str) -> String {
        use std::io::Write;
        let mut stream = std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(2))
            .expect("connect companion");
        stream
            .write_all(request.as_bytes())
            .expect("write request");
        stream
            .shutdown(std::net::Shutdown::Write)
            .expect("shutdown write");
        let mut body = String::new();
        stream.read_to_string(&mut body).expect("read response");
        body
    }
}
