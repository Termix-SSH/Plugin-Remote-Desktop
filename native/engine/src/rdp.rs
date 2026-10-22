//! A sans-IO RDP client on IronRDP. JS owns the socket and TLS: it feeds the
//! bytes it reads, writes the "send" events back, and upgrades the socket to
//! TLS when asked. Everything else (connection sequence, NLA, graphics,
//! channels) runs here.

use std::sync::{Arc, Mutex};

use ironrdp::connector::credssp::{CredsspSequence, KerberosConfig};
use ironrdp::connector::sspi::credssp::ClientState;
use ironrdp::connector::sspi::generator::GeneratorState;
use ironrdp::connector::{
    self, BitmapConfig, ClientConnector, ClientConnectorState, ConnectionResult, Credentials, DesktopSize, Sequence,
    ServerName,
};
use ironrdp::displaycontrol::client::DisplayControlClient;
use ironrdp::displaycontrol::pdu::MonitorLayoutEntry;
use ironrdp::dvc::DrdynvcClient;
use ironrdp::graphics::image_processing::PixelFormat;
use ironrdp::pdu::gcc::KeyboardType;
use ironrdp::pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags, SynchronizeFlags};
use ironrdp::pdu::input::mouse::PointerFlags;
use ironrdp::pdu::input::MousePdu;
use ironrdp::pdu::rdp::capability_sets::{client_codecs_capabilities, MajorPlatformType};
use ironrdp::pdu::rdp::client_info::{PerformanceFlags, TimezoneInfo};
use ironrdp::pdu::PduHint;
use ironrdp::session::image::DecodedImage;
use ironrdp::session::{ActiveStage, ActiveStageBuilder, ActiveStageOutput};
use ironrdp::connector::connection_activation::{ConnectionActivationSequence, ConnectionActivationState};
use ironrdp_core::WriteBuf;
use js_sys::{Array, Function, Object, Reflect, Uint8Array};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::clipboard::{ClipEvent, ClipboardBackend};
use crate::drive::{DriveBackend, DriveHost};
use crate::encode;
use crate::rail::RailApp;
use crate::sound::SoundBackend;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub host: String,
    pub username: String,
    pub password: String,
    pub domain: String,
    pub width: u16,
    pub height: u16,
    pub scale: u32,
    pub security: String,
    pub color_depth: u32,
    pub client_name: String,
    pub keyboard_layout: u32,
    pub wallpaper: bool,
    pub theming: bool,
    pub font_smoothing: bool,
    pub full_window_drag: bool,
    pub desktop_composition: bool,
    pub menu_animations: bool,
    pub audio: bool,
    pub clipboard: bool,
    pub drive_name: Option<String>,
    pub printer_name: Option<String>,
    pub printer_driver: Option<String>,
    pub display_control: bool,
    pub initial_program: String,
    pub work_dir: String,
    pub load_balance_info: String,
    pub timezone_bias: i32,
    pub timezone_name: String,
    pub kdc_url: String,
    /// guacd's preconnection-id and preconnection-blob, sent before X.224.
    pub preconnection_id: Option<u32>,
    pub preconnection_blob: String,
    /// Hyper-V console: blob, TLS and CredSSP all come before X.224.
    pub vmconnect: bool,
    /// Admin console session (mstsc /admin).
    pub console: bool,
    /// RemoteApp program, like "||notepad"; empty for a full desktop.
    pub remote_app: String,
    pub remote_app_dir: String,
    pub remote_app_args: String,
    pub lossy: bool,
}

enum Phase {
    /// Before the security upgrade, and again after CredSSP until connected.
    Connecting(Box<ClientConnector>),
    /// Waiting for JS to upgrade the socket to TLS.
    AwaitTls(Box<ClientConnector>),
    Credssp(Box<ClientConnector>, Box<CredsspSequence>),
    /// VMConnect: waiting for TLS right after the preconnection blob.
    VmTls(Box<ClientConnector>),
    /// VMConnect: CredSSP with the Hyper-V host, before X.224.
    VmCredssp(Box<ClientConnector>, Box<CredsspSequence>),
    Active(Box<Session>),
    Closed,
}

struct Session {
    stage: ActiveStage,
    image: DecodedImage,
    factory: ironrdp::connector::connection_activation::ConnectionActivationFactory,
    reactivation: Option<ConnectionActivationSequence>,
}

#[wasm_bindgen]
pub struct RdpClient {
    config: Config,
    phase: Phase,
    inbuf: Vec<u8>,
    events: Vec<JsValue>,
    host: Object,
    clip_events: Arc<Mutex<Vec<ClipEvent>>>,
    sound_events: Arc<Mutex<Vec<JsValue>>>,
    local_text: Option<String>,
    buttons: u32,
    last_x: u16,
    last_y: u16,
    /// VMConnect already did TLS and CredSSP when X.224 asks for them.
    vm_front_done: bool,
}

fn obj(kind: &str) -> Object {
    let o = Object::new();
    let _ = Reflect::set(&o, &"k".into(), &kind.into());
    o
}

fn set(o: &Object, key: &str, value: impl Into<JsValue>) {
    let _ = Reflect::set(o, &key.into(), &value.into());
}

#[wasm_bindgen]
impl RdpClient {
    /// `host` is an object of functions this client calls back synchronously:
    /// `network(protocol, url, data)` for Kerberos and the drive's `fs_*`.
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str, host: Object) -> Result<RdpClient, JsValue> {
        let config: Config =
            serde_json::from_str(config_json).map_err(|e| JsValue::from_str(&format!("bad config: {e}")))?;
        Ok(RdpClient {
            config,
            phase: Phase::Closed,
            inbuf: Vec::new(),
            events: Vec::new(),
            host,
            clip_events: Arc::new(Mutex::new(Vec::new())),
            sound_events: Arc::new(Mutex::new(Vec::new())),
            local_text: None,
            buttons: 0,
            last_x: 0,
            last_y: 0,
            vm_front_done: false,
        })
    }

    /// Starts the connection sequence. The first "send" event is the X.224 request.
    pub fn start(&mut self) {
        let connector = self.build_connector();
        if self.config.vmconnect {
            if self.config.preconnection_blob.trim().is_empty() {
                self.fail("protocol", "VMConnect needs the VM id as the preconnection blob");
                return;
            }
            match ironrdp::vmconnect::encode_preconnection_blob_payload(self.config.preconnection_blob.clone()) {
                Ok(pcb) => self.push_send(pcb),
                Err(e) => {
                    self.fail("protocol", &format!("{e:?}"));
                    return;
                }
            }
            self.phase = Phase::VmTls(Box::new(connector));
            self.events.push(obj("tls").into());
            return;
        }
        if self.config.preconnection_id.is_some() || !self.config.preconnection_blob.is_empty() {
            let has_blob = !self.config.preconnection_blob.is_empty();
            let blob = ironrdp::pdu::pcb::PreconnectionBlob {
                id: self.config.preconnection_id.unwrap_or(0),
                version: if has_blob {
                    ironrdp::pdu::pcb::PcbVersion::V2
                } else {
                    ironrdp::pdu::pcb::PcbVersion::V1
                },
                v2_payload: has_blob.then(|| self.config.preconnection_blob.clone()),
            };
            if let Ok(bytes) = ironrdp_core::encode_vec(&blob) {
                self.push_send(bytes);
            }
        }
        self.phase = Phase::Connecting(Box::new(connector));
        self.pump();
    }

    /// Bytes read from the socket (plaintext, after any TLS).
    pub fn feed(&mut self, data: &[u8]) {
        self.inbuf.extend_from_slice(data);
        self.pump();
    }

    /// The socket is now TLS. `public_key` is the server certificate's
    /// SubjectPublicKeyInfo key bytes, which CredSSP binds to.
    pub fn tls_done(&mut self, public_key: &[u8]) {
        let phase = std::mem::replace(&mut self.phase, Phase::Closed);
        if let Phase::VmTls(connector) = phase {
            let init = CredsspSequence::init(
                connector.config.credentials.clone(),
                connector.config.domain.as_deref(),
                ironrdp::pdu::nego::SecurityProtocol::HYBRID,
                ServerName::new(self.config.host.clone()),
                public_key.to_vec(),
                None,
            );
            match init {
                Ok((mut sequence, request)) => match self.credssp_process(&mut sequence, request) {
                    Ok(reply) => {
                        if let Some(reply) = reply {
                            self.push_send(reply);
                        }
                        self.phase = Phase::VmCredssp(connector, Box::new(sequence));
                    }
                    Err(e) => self.fail("auth", &e),
                },
                Err(e) => self.fail("auth", &e.to_string()),
            }
            self.pump();
            return;
        }
        let Phase::AwaitTls(mut connector) = phase else {
            self.phase = phase;
            return;
        };
        connector.mark_security_upgrade_as_done();
        if connector.should_perform_credssp() {
            match self.credssp_init(&connector, public_key.to_vec()) {
                Ok(sequence) => self.phase = Phase::Credssp(connector, Box::new(sequence)),
                Err(e) => self.fail("auth", &e),
            }
        } else {
            self.phase = Phase::Connecting(connector);
        }
        self.pump();
    }

    /// Drains the events produced since the last call.
    pub fn take_events(&mut self) -> Array {
        self.drain_side_channels();
        let out = Array::new();
        for event in self.events.drain(..) {
            out.push(&event);
        }
        out
    }

    pub fn width(&self) -> u16 {
        match &self.phase {
            Phase::Active(s) => s.image.width(),
            _ => self.config.width,
        }
    }

    pub fn height(&self) -> u16 {
        match &self.phase {
            Phase::Active(s) => s.image.height(),
            _ => self.config.height,
        }
    }

    pub fn encode_png(&self, x: usize, y: usize, w: usize, h: usize) -> Vec<u8> {
        match &self.phase {
            Phase::Active(s) => {
                let (x, y, w, h) = clip(&s.image, x, y, w, h);
                if w == 0 || h == 0 {
                    return Vec::new();
                }
                encode::png(s.image.data(), s.image.stride(), x, y, w, h, false)
            }
            _ => Vec::new(),
        }
    }

    pub fn encode_jpeg(&self, x: usize, y: usize, w: usize, h: usize, quality: u8) -> Vec<u8> {
        match &self.phase {
            Phase::Active(s) => {
                let (x, y, w, h) = clip(&s.image, x, y, w, h);
                if w == 0 || h == 0 {
                    return Vec::new();
                }
                encode::jpeg(s.image.data(), s.image.stride(), x, y, w, h, quality)
            }
            _ => Vec::new(),
        }
    }

    /// A key by scancode. Bit 8 set means an extended (0xE0) key.
    pub fn key(&mut self, scancode: u16, down: bool) {
        let mut flags = KeyboardFlags::empty();
        if !down {
            flags |= KeyboardFlags::RELEASE;
        }
        if scancode & 0x100 != 0 {
            flags |= KeyboardFlags::EXTENDED;
        }
        if scancode & 0x200 != 0 {
            flags |= KeyboardFlags::EXTENDED1;
        }
        self.input(vec![FastPathInputEvent::KeyboardEvent(flags, (scancode & 0xff) as u8)]);
    }

    /// A key by UTF-16 code unit, for characters the layout has no key for.
    pub fn unicode(&mut self, unit: u16, down: bool) {
        let flags = if down { KeyboardFlags::empty() } else { KeyboardFlags::RELEASE };
        self.input(vec![FastPathInputEvent::UnicodeKeyboardEvent(flags, unit)]);
    }

    pub fn sync_locks(&mut self, scroll: bool, num: bool, caps: bool) {
        let mut flags = SynchronizeFlags::empty();
        if scroll {
            flags |= SynchronizeFlags::SCROLL_LOCK;
        }
        if num {
            flags |= SynchronizeFlags::NUM_LOCK;
        }
        if caps {
            flags |= SynchronizeFlags::CAPS_LOCK;
        }
        self.input(vec![FastPathInputEvent::SyncEvent(flags)]);
    }

    /// A Guacamole mouse state: bit 0 left, 1 middle, 2 right, 3 wheel up, 4 wheel down.
    pub fn mouse(&mut self, x: u16, y: u16, mask: u32) {
        let mut events = Vec::new();
        let pdu = |flags: PointerFlags, wheel: i16| {
            FastPathInputEvent::MouseEvent(MousePdu {
                flags,
                number_of_wheel_rotation_units: wheel,
                x_position: x,
                y_position: y,
            })
        };
        if x != self.last_x || y != self.last_y || mask == self.buttons {
            events.push(pdu(PointerFlags::MOVE, 0));
        }
        let changed = mask ^ self.buttons;
        for (bit, flag) in [
            (1u32, PointerFlags::LEFT_BUTTON),
            (2, PointerFlags::MIDDLE_BUTTON_OR_WHEEL),
            (4, PointerFlags::RIGHT_BUTTON),
        ] {
            if changed & bit != 0 {
                let down = if mask & bit != 0 { PointerFlags::DOWN } else { PointerFlags::empty() };
                events.push(pdu(flag | down, 0));
            }
        }
        // Wheel "buttons" fire on press.
        if changed & 8 != 0 && mask & 8 != 0 {
            events.push(pdu(PointerFlags::VERTICAL_WHEEL, 120));
        }
        if changed & 16 != 0 && mask & 16 != 0 {
            events.push(pdu(PointerFlags::VERTICAL_WHEEL | PointerFlags::WHEEL_NEGATIVE, -120));
        }
        self.buttons = mask;
        self.last_x = x;
        self.last_y = y;
        self.input(events);
    }

    /// Asks the server to resize through Display Control. Returns false when
    /// the channel isn't there, so the caller can reconnect instead.
    pub fn resize(&mut self, width: u32, height: u32, scale: u32) -> bool {
        let Phase::Active(session) = &mut self.phase else {
            return false;
        };
        let (width, height) = MonitorLayoutEntry::adjust_display_size(width, height);
        let scale = if (100..=500).contains(&scale) { Some(scale) } else { None };
        match session.stage.encode_resize(width, height, scale, None) {
            Some(Ok(frame)) => {
                self.send(frame);
                true
            }
            _ => false,
        }
    }

    /// Text from the browser's clipboard, offered to the server.
    pub fn clipboard_set(&mut self, text: String) {
        self.local_text = Some(text);
        self.offer_clipboard();
    }

    pub fn shutdown(&mut self) {
        if let Phase::Active(session) = &mut self.phase {
            if let Ok(outputs) = session.stage.graceful_shutdown() {
                for out in outputs {
                    if let ActiveStageOutput::ResponseFrame(frame) = out {
                        self.send(frame);
                    }
                }
            }
        }
    }

    /// Timers: clipboard lock timeouts and deferred drive replies.
    pub fn tick(&mut self) {
        let Phase::Active(session) = &mut self.phase else {
            return;
        };
        let mut frames = Vec::new();
        if let Some(cliprdr) = session.stage.get_svc_processor_mut::<ironrdp::cliprdr::CliprdrClient>() {
            if let Ok(messages) = cliprdr.drive_timeouts() {
                if let Ok(frame) = session.stage.process_svc_processor_messages(messages) {
                    frames.push(frame);
                }
            }
        }
        if let Some(rdpdr) = session.stage.get_svc_processor_mut::<ironrdp::rdpdr::Rdpdr>() {
            if let Ok(messages) = rdpdr.poll_deferred_messages() {
                if !messages.is_empty() {
                    if let Ok(frame) = session
                        .stage
                        .process_svc_processor_messages(ironrdp_svc::SvcProcessorMessages::<ironrdp::rdpdr::Rdpdr>::new(messages))
                    {
                        frames.push(frame);
                    }
                }
            }
        }
        let rail_failure = session
            .stage
            .get_svc_processor_mut::<RailApp>()
            .and_then(|rail| rail.failure.take());
        for frame in frames {
            if !frame.is_empty() {
                self.send(frame);
            }
        }
        if let Some(reason) = rail_failure {
            self.fail("remoteapp", &reason);
            return;
        }
        self.drain_side_channels();
    }
}

fn clip(image: &DecodedImage, x: usize, y: usize, w: usize, h: usize) -> (usize, usize, usize, usize) {
    let iw = usize::from(image.width());
    let ih = usize::from(image.height());
    let x = x.min(iw);
    let y = y.min(ih);
    (x, y, w.min(iw - x), h.min(ih - y))
}

impl RdpClient {
    fn build_connector(&mut self) -> ClientConnector {
        let c = &self.config;
        let (enable_tls, enable_credssp, enable_rdp) = match c.security.as_str() {
            "nla" | "nla-ext" => (false, true, false),
            "vmconnect" => (true, true, false),
            "tls" => (true, false, false),
            "rdp" => (false, false, true),
            _ => (true, true, false),
        };
        let mut perf = PerformanceFlags::empty();
        if !c.wallpaper {
            perf |= PerformanceFlags::DISABLE_WALLPAPER;
        }
        if !c.theming {
            perf |= PerformanceFlags::DISABLE_THEMING;
        }
        if !c.full_window_drag {
            perf |= PerformanceFlags::DISABLE_FULLWINDOWDRAG;
        }
        if !c.menu_animations {
            perf |= PerformanceFlags::DISABLE_MENUANIMATIONS;
        }
        if c.font_smoothing {
            perf |= PerformanceFlags::ENABLE_FONT_SMOOTHING;
        }
        if c.desktop_composition {
            perf |= PerformanceFlags::ENABLE_DESKTOP_COMPOSITION;
        }
        let color_depth = match c.color_depth {
            8 | 15 | 16 | 24 | 32 => c.color_depth,
            _ => 32,
        };
        let codecs = client_codecs_capabilities(&[]).unwrap_or_default();
        let timezone_info = TimezoneInfo {
            bias: c.timezone_bias,
            standard_name: c.timezone_name.clone(),
            daylight_name: c.timezone_name.clone(),
            ..TimezoneInfo::default()
        };
        let config = connector::Config {
            credentials: Credentials::UsernamePassword {
                username: c.username.clone(),
                password: c.password.clone(),
            },
            domain: if c.domain.is_empty() { None } else { Some(c.domain.clone()) },
            enable_tls,
            enable_credssp,
            enable_standard_rdp_security: enable_rdp,
            keyboard_type: KeyboardType::IBM_ENHANCED,
            keyboard_subtype: 0,
            keyboard_layout: c.keyboard_layout,
            keyboard_functional_keys_count: 12,
            connection_type: ironrdp::pdu::gcc::ConnectionType::Lan,
            ime_file_name: String::new(),
            dig_product_id: String::new(),
            desktop_size: DesktopSize {
                width: c.width.max(200),
                height: c.height.max(200),
            },
            monitor_layout: None,
            bitmap: Some(BitmapConfig {
                color_depth,
                lossy_compression: c.lossy,
                codecs,
            }),
            client_build: 0,
            client_name: if c.client_name.is_empty() { "Termix".to_owned() } else { c.client_name.clone() },
            client_dir: "C:\\Windows\\System32\\mstscax.dll".to_owned(),
            platform: MajorPlatformType::UNSPECIFIED,
            compression_type: None,
            enable_server_pointer: true,
            autologon: !c.username.is_empty() || !c.password.is_empty(),
            enable_audio_playback: c.audio,
            enable_audio_capture: false,
            request_data: None,
            pointer_software_rendering: false,
            multitransport_flags: None,
            support_dyn_vc_gfx_protocol: false,
            performance_flags: perf,
            desktop_scale_factor: if (100..=500).contains(&c.scale) { c.scale } else { 0 },
            hardware_id: None,
            license_cache: None,
            timezone_info,
            alternate_shell: c.initial_program.clone(),
            work_dir: c.work_dir.clone(),
            remote_application_mode: !c.remote_app.is_empty(),
            rail_support_level: if c.remote_app.is_empty() {
                ironrdp::pdu::rdp::capability_sets::RailSupportLevel::empty()
            } else {
                ironrdp::pdu::rdp::capability_sets::RailSupportLevel::SUPPORTED
                    | ironrdp::pdu::rdp::capability_sets::RailSupportLevel::HANDSHAKE_EX_SUPPORTED
            },
        };

        let client_addr = core::net::SocketAddr::from(([127, 0, 0, 1], 0));
        let mut connector = ClientConnector::new(config, client_addr);
        if !c.load_balance_info.is_empty() {
            connector = connector.with_load_balance_info(c.load_balance_info.clone());
        }
        if c.console {
            connector = connector.with_cluster_data(ironrdp::pdu::gcc::ClientClusterData {
                flags: ironrdp::pdu::gcc::RedirectionFlags::REDIRECTION_SUPPORTED
                    | ironrdp::pdu::gcc::RedirectionFlags::REDIRECTED_SESSION_FIELD_VALID,
                redirection_version: ironrdp::pdu::gcc::RedirectionVersion::V6,
                redirected_session_id: 0,
            });
        }
        if !c.remote_app.is_empty() {
            connector.attach_static_channel(RailApp::new(
                c.remote_app.clone(),
                c.remote_app_dir.clone(),
                c.remote_app_args.clone(),
                c.width.max(200),
                c.height.max(200),
            ));
        }
        if c.clipboard {
            connector.attach_static_channel(ironrdp::cliprdr::CliprdrClient::new(Box::new(ClipboardBackend::new(
                Arc::clone(&self.clip_events),
            ))));
        }
        // Windows only talks RDPDR when RDPSND is offered too, so sound is
        // always attached; with audio off it just offers no formats.
        let drive = c.drive_name.clone();
        let printer = c.printer_name.clone();
        connector.attach_static_channel(ironrdp::rdpsnd::client::Rdpsnd::new(Box::new(SoundBackend::new(
            c.audio,
            Arc::clone(&self.sound_events),
        ))));
        if drive.is_some() || printer.is_some() {
            let backend = DriveBackend::new(DriveHost::new(self.host.clone()));
            let mut rdpdr = ironrdp::rdpdr::Rdpdr::new(Box::new(backend), self.config.client_name.clone());
            if let Some(name) = drive {
                rdpdr = rdpdr.with_drives(Some(vec![(1, name)]));
            }
            if let Some(name) = printer {
                let driver = self
                    .config
                    .printer_driver
                    .clone()
                    .unwrap_or_else(|| "Microsoft Print To PDF".to_owned());
                rdpdr = rdpdr.with_printer_driver(2, name, driver);
            }
            connector.attach_static_channel(rdpdr);
        }
        if self.config.display_control {
            connector.attach_static_channel(
                DrdynvcClient::new().with_dynamic_channel(DisplayControlClient::new(|_| Ok(Vec::new()))),
            );
        }
        connector
    }

    fn credssp_init(&mut self, connector: &ClientConnector, public_key: Vec<u8>) -> Result<CredsspSequence, String> {
        let ClientConnectorState::Credssp { selected_protocol } = connector.state else {
            return Err("invalid connector state for CredSSP".to_owned());
        };
        let kerberos = if self.config.kdc_url.is_empty() {
            None
        } else {
            KerberosConfig::new(Some(self.config.kdc_url.clone()), self.config.client_name.clone()).ok()
        };
        let (mut sequence, request) = CredsspSequence::init(
            connector.config.credentials.clone(),
            connector.config.domain.as_deref(),
            selected_protocol,
            ServerName::new(self.config.host.clone()),
            public_key,
            kerberos,
        )
        .map_err(|e| e.to_string())?;
        if let Some(reply) = self.credssp_process(&mut sequence, request)? {
            self.push_send(reply);
        }
        Ok(sequence)
    }

    /// Runs one CredSSP request and sends the reply. Kerberos network calls
    /// go to the host's `network` function, which blocks in the worker.
    fn credssp_process(
        &self,
        sequence: &mut CredsspSequence,
        request: ironrdp::connector::sspi::credssp::TsRequest,
    ) -> Result<Option<Vec<u8>>, String> {
        let result = {
            let mut generator = sequence.process_ts_request(request);
            let mut state = generator.start();
            loop {
                match state {
                    GeneratorState::Suspended(request) => {
                        let response = self.network(request.protocol as u8, request.url.as_str(), &request.data);
                        state = generator.resume(response.map_err(|e| {
                            ironrdp::connector::sspi::Error::new(
                                ironrdp::connector::sspi::ErrorKind::NoAuthenticatingAuthority,
                                e,
                            )
                        }));
                    }
                    GeneratorState::Completed(client_state) => break client_state,
                }
            }
        };
        let client_state: ClientState = result.map_err(|e| e.to_string())?;
        let mut buf = WriteBuf::new();
        let written = sequence
            .handle_process_result(client_state, &mut buf)
            .map_err(|e| e.to_string())?;
        Ok(written.size().map(|len| buf.filled()[..len].to_vec()))
    }

    fn network(&self, protocol: u8, url: &str, data: &[u8]) -> Result<Vec<u8>, String> {
        let f = Reflect::get(&self.host, &"network".into())
            .ok()
            .and_then(|f| f.dyn_into::<Function>().ok())
            .ok_or("Kerberos needs a network function")?;
        let out = f
            .call3(&JsValue::NULL, &protocol.into(), &url.into(), &Uint8Array::from(data))
            .map_err(|e| e.as_string().unwrap_or_else(|| "network request failed".to_owned()))?;
        Ok(Uint8Array::new(&out).to_vec())
    }

    fn pump(&mut self) {
        loop {
            let progressed = match std::mem::replace(&mut self.phase, Phase::Closed) {
                Phase::Connecting(connector) => self.pump_connecting(connector),
                Phase::Credssp(connector, sequence) => self.pump_credssp(connector, sequence),
                Phase::VmCredssp(connector, sequence) => self.pump_vm_credssp(connector, sequence),
                Phase::Active(session) => self.pump_active(session),
                other => {
                    self.phase = other;
                    false
                }
            };
            if !progressed {
                break;
            }
        }
    }

    /// Takes one whole PDU off the input if the hint says it is complete.
    fn take_frame(&mut self, hint: &dyn PduHint) -> Result<Option<Vec<u8>>, String> {
        match hint.find_size(&self.inbuf) {
            Ok(Some((_, len))) if self.inbuf.len() >= len => Ok(Some(self.inbuf.drain(..len).collect())),
            Ok(_) => Ok(None),
            Err(e) => Err(format!("{e:?}")),
        }
    }

    fn pump_connecting(&mut self, mut connector: Box<ClientConnector>) -> bool {
        if self.vm_front_done && connector.should_perform_security_upgrade() {
            connector.mark_security_upgrade_as_done();
            if connector.should_perform_credssp() {
                connector.mark_credssp_as_done();
            }
            self.phase = Phase::Connecting(connector);
            return true;
        }
        if connector.should_perform_security_upgrade() {
            self.phase = Phase::AwaitTls(connector);
            self.events.push(obj("tls").into());
            return false;
        }
        if let ClientConnectorState::Connected { .. } = connector.state {
            let ClientConnectorState::Connected { result } = std::mem::take(&mut connector.state) else {
                unreachable!()
            };
            self.connected(result);
            return true;
        }
        let mut buf = WriteBuf::new();
        let step = match connector.next_pdu_hint() {
            None => connector.step_no_input(&mut buf),
            Some(hint) => match self.take_frame(hint) {
                Ok(Some(frame)) => {
                    if is_multitransport_during_licensing(&connector, &frame) {
                        self.phase = Phase::Connecting(connector);
                        return true;
                    }
                    connector.step(&frame, None, &mut buf)
                }
                Ok(None) => {
                    self.phase = Phase::Connecting(connector);
                    return false;
                }
                Err(e) => {
                    self.fail("protocol", &e);
                    return false;
                }
            },
        };
        match step {
            Ok(written) => {
                if let Some(len) = written.size() {
                    self.push_send(buf.filled()[..len].to_vec());
                }
                self.phase = Phase::Connecting(connector);
                true
            }
            Err(e) => {
                let kind = classify(&e);
                self.fail(kind, &format!("{e:?}"));
                false
            }
        }
    }

    fn pump_credssp(&mut self, mut connector: Box<ClientConnector>, mut sequence: Box<CredsspSequence>) -> bool {
        let Some(hint) = sequence.next_pdu_hint() else {
            connector.mark_credssp_as_done();
            self.phase = Phase::Connecting(connector);
            return true;
        };
        let frame = match self.take_frame(hint) {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                self.phase = Phase::Credssp(connector, sequence);
                return false;
            }
            Err(e) => {
                self.fail("auth", &e);
                return false;
            }
        };
        match sequence.decode_server_message(&frame) {
            Ok(Some(request)) => {
                match self.credssp_process(&mut sequence, request) {
                    Ok(Some(reply)) => self.push_send(reply),
                    Ok(None) => {}
                    Err(e) => {
                        self.fail("auth", &e);
                        return false;
                    }
                }
                self.phase = Phase::Credssp(connector, sequence);
                true
            }
            Ok(None) => {
                connector.mark_credssp_as_done();
                self.phase = Phase::Connecting(connector);
                true
            }
            Err(e) => {
                self.fail("auth", &e.to_string());
                false
            }
        }
    }

    /// CredSSP with the Hyper-V host, then X.224 asking for HYBRID. The guest
    /// gets no credentials: Enhanced Session signs in on its own screen.
    fn pump_vm_credssp(&mut self, mut connector: Box<ClientConnector>, mut sequence: Box<CredsspSequence>) -> bool {
        let done = match sequence.next_pdu_hint() {
            None => true,
            Some(hint) => {
                let frame = match self.take_frame(hint) {
                    Ok(Some(frame)) => frame,
                    Ok(None) => {
                        self.phase = Phase::VmCredssp(connector, sequence);
                        return false;
                    }
                    Err(e) => {
                        self.fail("auth", &e);
                        return false;
                    }
                };
                match sequence.decode_server_message(&frame) {
                    Ok(Some(request)) => {
                        match self.credssp_process(&mut sequence, request) {
                            Ok(Some(reply)) => self.push_send(reply),
                            Ok(None) => {}
                            Err(e) => {
                                self.fail("auth", &e);
                                return false;
                            }
                        }
                        false
                    }
                    Ok(None) => true,
                    Err(e) => {
                        self.fail("auth", &e.to_string());
                        return false;
                    }
                }
            }
        };
        if !done {
            self.phase = Phase::VmCredssp(connector, sequence);
            return true;
        }
        connector.config.credentials = Credentials::UsernamePassword {
            username: String::new(),
            password: String::new(),
        };
        connector.config.domain = None;
        connector.config.autologon = false;
        let mut buf = WriteBuf::new();
        match connector.initiate_with_security_protocol(ironrdp::pdu::nego::SecurityProtocol::HYBRID, &mut buf) {
            Ok(written) => {
                if let Some(len) = written.size() {
                    self.push_send(buf.filled()[..len].to_vec());
                }
            }
            Err(e) => {
                self.fail("protocol", &format!("{e:?}"));
                return false;
            }
        }
        self.vm_front_done = true;
        self.phase = Phase::Connecting(connector);
        true
    }

    fn connected(&mut self, result: ConnectionResult) {
        let image = DecodedImage::new(PixelFormat::RgbA32, result.desktop_size.width, result.desktop_size.height);
        let stage = ActiveStageBuilder {
            static_channels: result.static_channels,
            user_channel_id: result.user_channel_id,
            io_channel_id: result.io_channel_id,
            message_channel_id: result.message_channel_id,
            share_id: result.share_id,
            compression_type: result.compression_type,
            enable_server_pointer: result.enable_server_pointer,
            pointer_software_rendering: result.pointer_software_rendering,
        }
        .build();
        let e = obj("connected");
        set(&e, "w", image.width());
        set(&e, "h", image.height());
        self.events.push(e.into());
        self.phase = Phase::Active(Box::new(Session {
            stage,
            image,
            factory: result.activation_factory,
            reactivation: None,
        }));
    }

    fn pump_active(&mut self, mut session: Box<Session>) -> bool {
        if session.reactivation.is_some() {
            return self.pump_reactivation(session);
        }
        let info = match ironrdp::pdu::find_size(&self.inbuf) {
            Ok(Some(info)) if self.inbuf.len() >= info.length => info,
            Ok(_) => {
                self.phase = Phase::Active(session);
                return false;
            }
            Err(e) => {
                self.fail("protocol", &format!("{e:?}"));
                return false;
            }
        };
        let frame: Vec<u8> = self.inbuf.drain(..info.length).collect();
        let Session { stage, image, .. } = &mut *session;
        match stage.process(image, info.action, &frame) {
            Ok(outputs) => {
                let keep = self.handle_outputs(&mut session, outputs);
                if keep {
                    self.phase = Phase::Active(session);
                }
                keep
            }
            Err(e) => {
                self.fail("protocol", &format!("{e:?}"));
                false
            }
        }
    }

    fn pump_reactivation(&mut self, mut session: Box<Session>) -> bool {
        let Some(activation) = session.reactivation.as_mut() else {
            self.phase = Phase::Active(session);
            return true;
        };
        // Graphics the server sent before it deactivated can still be queued;
        // they belong to the old surface, so they are dropped.
        if let Ok(Some(info)) = ironrdp::pdu::find_size(&self.inbuf) {
            if info.action == ironrdp::pdu::Action::FastPath {
                if self.inbuf.len() < info.length {
                    self.phase = Phase::Active(session);
                    return false;
                }
                self.inbuf.drain(..info.length);
                self.phase = Phase::Active(session);
                return true;
            }
            // Virtual channel data (sound, clipboard) keeps flowing during
            // reactivation; the session handles it, not the activation.
            if let Some(channel) = mcs_channel(&self.inbuf) {
                if channel != activation.io_channel_id() {
                    if self.inbuf.len() < info.length {
                        self.phase = Phase::Active(session);
                        return false;
                    }
                    let frame: Vec<u8> = self.inbuf.drain(..info.length).collect();
                    let Session { stage, image, .. } = &mut *session;
                    match stage.process(image, info.action, &frame) {
                        Ok(outputs) => {
                            for out in outputs {
                                if let ActiveStageOutput::ResponseFrame(frame) = out {
                                    if !frame.is_empty() {
                                        self.push_send(frame);
                                    }
                                }
                            }
                        }
                        Err(e) => self.events.push({
                            let e2 = obj("log");
                            set(&e2, "message", format!("channel data during reactivation: {e}"));
                            e2.into()
                        }),
                    }
                    self.phase = Phase::Active(session);
                    return true;
                }
            }
        }
        let mut buf = WriteBuf::new();
        let step = match activation.next_pdu_hint() {
            None => activation.step_no_input(&mut buf),
            Some(hint) => match self.take_frame(hint) {
                Ok(Some(frame)) => activation.step(&frame, None, &mut buf),
                Ok(None) => {
                    self.phase = Phase::Active(session);
                    return false;
                }
                Err(e) => {
                    self.fail("protocol", &e);
                    return false;
                }
            },
        };
        match step {
            Ok(written) => {
                if let Some(len) = written.size() {
                    self.push_send(buf.filled()[..len].to_vec());
                }
            }
            Err(e) => {
                self.fail("protocol", &format!("{e:?}"));
                return false;
            }
        }
        if let ConnectionActivationState::Finalized {
            desktop_size,
            share_id,
            enable_server_pointer,
            pointer_software_rendering,
            static_channel_chunk_size,
            window_support_level,
            ..
        } = activation.connection_activation_state()
        {
            let io = activation.io_channel_id();
            let user = activation.user_channel_id();
            session.reactivation = None;
            session.image = DecodedImage::new(PixelFormat::RgbA32, desktop_size.width, desktop_size.height);
            if !session.stage.reactivate(
                io,
                user,
                share_id,
                enable_server_pointer,
                pointer_software_rendering,
                static_channel_chunk_size,
            ) {
                self.fail("protocol", "invalid static channel chunk size");
                return false;
            }
            session.stage.set_window_support_level(window_support_level);
            let e = obj("resize");
            set(&e, "w", desktop_size.width);
            set(&e, "h", desktop_size.height);
            self.events.push(e.into());
        }
        self.phase = Phase::Active(session);
        true
    }

    /// Returns false when the session ended.
    fn handle_outputs(&mut self, session: &mut Session, outputs: Vec<ActiveStageOutput>) -> bool {
        for out in outputs {
            match out {
                ActiveStageOutput::ResponseFrame(frame) => {
                    if !frame.is_empty() {
                        self.push_send(frame);
                    }
                }
                ActiveStageOutput::GraphicsUpdate(r) => {
                    let e = obj("dirty");
                    set(&e, "x", r.left);
                    set(&e, "y", r.top);
                    set(&e, "w", r.right.saturating_sub(r.left) + 1);
                    set(&e, "h", r.bottom.saturating_sub(r.top) + 1);
                    self.events.push(e.into());
                }
                ActiveStageOutput::PointerDefault => self.events.push(obj("pointerDefault").into()),
                ActiveStageOutput::PointerHidden => self.events.push(obj("pointerHidden").into()),
                ActiveStageOutput::PointerPosition { x, y } => {
                    let e = obj("pointerPosition");
                    set(&e, "x", x);
                    set(&e, "y", y);
                    self.events.push(e.into());
                }
                ActiveStageOutput::PointerBitmap(p) => {
                    let e = obj("pointer");
                    set(&e, "w", p.width);
                    set(&e, "h", p.height);
                    set(&e, "hx", p.hotspot_x);
                    set(&e, "hy", p.hotspot_y);
                    set(&e, "data", Uint8Array::from(p.bitmap_data.as_slice()));
                    self.events.push(e.into());
                }
                ActiveStageOutput::DeactivateAll => {
                    session.reactivation = Some(session.factory.create());
                }
                ActiveStageOutput::SaveSessionInfo { logon_complete: true } => {
                    self.events.push(obj("logon").into());
                }
                ActiveStageOutput::Terminate(reason) => {
                    let e = obj("terminated");
                    set(&e, "reason", reason.description());
                    self.events.push(e.into());
                    self.phase = Phase::Closed;
                    return false;
                }
                _ => {}
            }
        }
        true
    }

    fn input(&mut self, events: Vec<FastPathInputEvent>) {
        if events.is_empty() {
            return;
        }
        let Phase::Active(session) = &mut self.phase else {
            return;
        };
        let Session { stage, image, .. } = &mut **session;
        if let Ok(outputs) = stage.process_fastpath_input(image, &events) {
            for out in outputs {
                if let ActiveStageOutput::ResponseFrame(frame) = out {
                    self.events.push(send_event(frame));
                }
            }
        }
    }

    fn offer_clipboard(&mut self) {
        let has_text = self.local_text.is_some();
        let Phase::Active(session) = &mut self.phase else {
            return;
        };
        let Some(cliprdr) = session.stage.get_svc_processor_mut::<ironrdp::cliprdr::CliprdrClient>() else {
            return;
        };
        let formats = if has_text {
            vec![ironrdp::cliprdr::pdu::ClipboardFormat::new(
                ironrdp::cliprdr::pdu::ClipboardFormatId::CF_UNICODETEXT,
            )]
        } else {
            Vec::new()
        };
        if let Ok(messages) = cliprdr.initiate_copy(&formats) {
            if let Ok(frame) = session.stage.process_svc_processor_messages(messages) {
                if !frame.is_empty() {
                    self.events.push(send_event(frame));
                }
            }
        }
    }

    /// Acts on what the clipboard and sound backends queued while a PDU was processed.
    fn drain_side_channels(&mut self) {
        let clip: Vec<ClipEvent> = self.clip_events.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
        for event in clip {
            match event {
                ClipEvent::Ready | ClipEvent::FormatListRequested => self.offer_clipboard(),
                ClipEvent::RemoteCopy(has_text) => {
                    if !has_text {
                        continue;
                    }
                    if let Phase::Active(session) = &mut self.phase {
                        if let Some(cliprdr) =
                            session.stage.get_svc_processor_mut::<ironrdp::cliprdr::CliprdrClient>()
                        {
                            if let Ok(messages) =
                                cliprdr.initiate_paste(ironrdp::cliprdr::pdu::ClipboardFormatId::CF_UNICODETEXT)
                            {
                                if let Ok(frame) = session.stage.process_svc_processor_messages(messages) {
                                    if !frame.is_empty() {
                                        self.events.push(send_event(frame));
                                    }
                                }
                            }
                        }
                    }
                }
                ClipEvent::DataRequested => {
                    let text = self.local_text.clone().unwrap_or_default();
                    if let Phase::Active(session) = &mut self.phase {
                        if let Some(cliprdr) =
                            session.stage.get_svc_processor_mut::<ironrdp::cliprdr::CliprdrClient>()
                        {
                            let response =
                                ironrdp::cliprdr::pdu::OwnedFormatDataResponse::new_unicode_string(&text);
                            if let Ok(messages) = cliprdr.submit_format_data(response) {
                                if let Ok(frame) = session.stage.process_svc_processor_messages(messages) {
                                    if !frame.is_empty() {
                                        self.events.push(send_event(frame));
                                    }
                                }
                            }
                        }
                    }
                }
                ClipEvent::Text(text) => {
                    let e = obj("clipboard");
                    set(&e, "text", text);
                    self.events.push(e.into());
                }
            }
        }
        let sound: Vec<JsValue> = self.sound_events.lock().map(|mut q| q.drain(..).collect()).unwrap_or_default();
        self.events.extend(sound);
    }

    fn push_send(&mut self, data: Vec<u8>) {
        self.events.push(send_event(data));
    }

    fn send(&mut self, data: Vec<u8>) {
        self.push_send(data);
    }

    fn fail(&mut self, kind: &str, message: &str) {
        let e = obj("error");
        set(&e, "kind", kind);
        set(&e, "message", message);
        self.events.push(e.into());
        self.phase = Phase::Closed;
    }
}

/// Some servers send an Initiate Multitransport Request on the message channel
/// before the license exchange is over, which the connector only expects
/// after it. License PDUs use the I/O channel, so the offer is skipped and the
/// session stays on TCP.
fn is_multitransport_during_licensing(connector: &ClientConnector, frame: &[u8]) -> bool {
    matches!(connector.state, ClientConnectorState::LicensingExchange { .. })
        && connector.message_channel_id.is_some()
        && mcs_channel(frame) == connector.message_channel_id
}

/// The channel of a slow-path MCS Send Data Indication, if `frame` starts one.
fn mcs_channel(frame: &[u8]) -> Option<u16> {
    // TPKT (4) + X.224 data (3), then the MCS PDU type and initiator.
    if frame.len() < 12 || frame[0] != 3 || frame[7] >> 2 != 26 {
        return None;
    }
    Some(u16::from_be_bytes([frame[10], frame[11]]))
}

fn send_event(data: Vec<u8>) -> JsValue {
    let e = obj("send");
    set(&e, "data", Uint8Array::from(data.as_slice()));
    e.into()
}

/// Sorts a connector error into what the user sees.
fn classify(error: &connector::ConnectorError) -> &'static str {
    use ironrdp::connector::ConnectorErrorKind as K;
    match error.kind() {
        K::Credssp(_) | K::AccessDenied => "auth",
        K::Negotiation(_) => "negotiation",
        _ => "protocol",
    }
}
