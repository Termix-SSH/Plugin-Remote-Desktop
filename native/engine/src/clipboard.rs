//! CLIPRDR backend. Callbacks fire while a PDU is processed, when the
//! channel is borrowed, so they only queue what happened; the client acts
//! on the queue afterwards.

use std::sync::{Arc, Mutex};

use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest, FileContentsResponse,
    FormatDataRequest, FormatDataResponse, LockDataId,
};
use ironrdp_core::impl_as_any;

#[derive(Debug)]
pub enum ClipEvent {
    Ready,
    FormatListRequested,
    /// The server copied something; true when it has text.
    RemoteCopy(bool),
    /// The server wants our text.
    DataRequested,
    /// Text the server sent.
    Text(String),
}

#[derive(Debug)]
pub struct ClipboardBackend {
    events: Arc<Mutex<Vec<ClipEvent>>>,
}

impl ClipboardBackend {
    pub fn new(events: Arc<Mutex<Vec<ClipEvent>>>) -> Self {
        Self { events }
    }

    fn push(&self, event: ClipEvent) {
        if let Ok(mut q) = self.events.lock() {
            q.push(event);
        }
    }
}

impl_as_any!(ClipboardBackend);

impl CliprdrBackend for ClipboardBackend {
    fn temporary_directory(&self) -> &str {
        "."
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
    }

    fn on_ready(&mut self) {
        self.push(ClipEvent::Ready);
    }

    fn on_request_format_list(&mut self) {
        self.push(ClipEvent::FormatListRequested);
    }

    fn on_process_negotiated_capabilities(&mut self, _capabilities: ClipboardGeneralCapabilityFlags) {}

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        let has_text = available_formats
            .iter()
            .any(|f| f.id == ClipboardFormatId::CF_UNICODETEXT);
        self.push(ClipEvent::RemoteCopy(has_text));
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        if request.format == ClipboardFormatId::CF_UNICODETEXT {
            self.push(ClipEvent::DataRequested);
        }
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            return;
        }
        if let Ok(text) = response.to_unicode_string() {
            self.push(ClipEvent::Text(text));
        }
    }

    fn on_file_contents_request(&mut self, _request: FileContentsRequest) {}

    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}

    // The default reads std::time::Instant, which panics in WASM.
    fn now_ms(&self) -> u64 {
        js_sys::Date::now() as u64
    }
}
