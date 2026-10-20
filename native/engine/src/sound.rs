//! RDPSND backend: hands PCM to JS, which streams it as audio/L16.

use std::borrow::Cow;
use std::sync::{Arc, Mutex};

use ironrdp::rdpsnd::client::RdpsndClientHandler;
use ironrdp::rdpsnd::pdu::{AudioFormat, PitchPdu, VolumePdu, WaveFormat};
use js_sys::{Object, Reflect, Uint8Array};
use wasm_bindgen::JsValue;

#[derive(Debug)]
pub struct SoundBackend {
    formats: Vec<AudioFormat>,
    events: Arc<Mutex<Vec<JsValue>>>,
    waved: bool,
}

fn pcm(rate: u32, channels: u16) -> AudioFormat {
    AudioFormat {
        format: WaveFormat::PCM,
        n_channels: channels,
        n_samples_per_sec: rate,
        n_avg_bytes_per_sec: rate * u32::from(channels) * 2,
        n_block_align: channels * 2,
        bits_per_sample: 16,
        data: None,
    }
}

impl SoundBackend {
    fn note(&self, message: &str) {
        let e = Object::new();
        let _ = Reflect::set(&e, &"k".into(), &"debug".into());
        let _ = Reflect::set(&e, &"message".into(), &message.into());
        if let Ok(mut q) = self.events.lock() {
            q.push(e.into());
        }
    }

    pub fn new(enabled: bool, events: Arc<Mutex<Vec<JsValue>>>) -> Self {
        let formats = if enabled {
            vec![pcm(44100, 2), pcm(22050, 2), pcm(48000, 2)]
        } else {
            Vec::new()
        };
        Self { formats, events, waved: false }
    }
}

impl RdpsndClientHandler for SoundBackend {
    fn get_formats(&self) -> &[AudioFormat] {
        self.note(&format!("rdpsnd formats requested, offering {}", self.formats.len()));
        &self.formats
    }

    fn wave(&mut self, format: &AudioFormat, _ts: u32, data: Cow<'_, [u8]>) {
        if !self.waved {
            self.waved = true;
            self.note(&format!(
                "rdpsnd first wave, format {:?} bits {} rate {} bytes {}",
                format.format, format.bits_per_sample, format.n_samples_per_sec, data.len()
            ));
        }
        if format.format != WaveFormat::PCM || format.bits_per_sample != 16 {
            return;
        }
        let e = Object::new();
        let _ = Reflect::set(&e, &"k".into(), &"audio".into());
        let _ = Reflect::set(&e, &"rate".into(), &format.n_samples_per_sec.into());
        let _ = Reflect::set(&e, &"channels".into(), &format.n_channels.into());
        let _ = Reflect::set(&e, &"data".into(), &Uint8Array::from(data.as_ref()));
        if let Ok(mut q) = self.events.lock() {
            q.push(e.into());
        }
    }

    fn set_volume(&mut self, _volume: VolumePdu) {}

    fn set_pitch(&mut self, _pitch: PitchPdu) {}

    fn close(&mut self) {}
}

// JsValue is not Send, but WASM here is single threaded.
unsafe impl Send for SoundBackend {}
