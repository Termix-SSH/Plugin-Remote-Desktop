//! Decoding helpers for VNC: a zlib stream that lives across rectangles
//! (ZRLE, Tight) and JPEG decoding straight into a surface.

use flate2::{Decompress, FlushDecompress, Status};
use wasm_bindgen::prelude::*;

use crate::surface::Surface;

#[wasm_bindgen]
pub struct Inflater {
    inner: Decompress,
}

#[wasm_bindgen]
impl Inflater {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Inflater {
        Inflater {
            inner: Decompress::new(true),
        }
    }

    /// Inflates `input` with a sync flush. `expected` sizes the first buffer.
    pub fn inflate(&mut self, input: &[u8], expected: usize) -> Result<Vec<u8>, JsValue> {
        let mut out = Vec::with_capacity(expected.max(1024));
        let mut consumed = 0usize;
        loop {
            if out.len() == out.capacity() {
                out.reserve(out.capacity().max(4096));
            }
            let before_in = self.inner.total_in();
            let status = self
                .inner
                .decompress_vec(&input[consumed..], &mut out, FlushDecompress::Sync)
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
            consumed += (self.inner.total_in() - before_in) as usize;
            match status {
                Status::StreamEnd => break,
                _ if consumed >= input.len() && out.len() < out.capacity() => break,
                _ => {}
            }
        }
        Ok(out)
    }

    pub fn reset(&mut self) {
        self.inner.reset(true);
    }
}

impl Default for Inflater {
    fn default() -> Self {
        Self::new()
    }
}

/// Decodes a JPEG into the surface at (x, y). Returns false when it can't.
#[wasm_bindgen]
pub fn decode_jpeg_into(surface: &mut Surface, x: usize, y: usize, jpeg: &[u8]) -> bool {
    let options = zune_jpeg::zune_core::options::DecoderOptions::default()
        .jpeg_set_out_colorspace(zune_jpeg::zune_core::colorspace::ColorSpace::RGBA);
    let mut decoder = zune_jpeg::JpegDecoder::new_with_options(jpeg, options);
    let Ok(pixels) = decoder.decode() else {
        return false;
    };
    let Some(info) = decoder.info() else {
        return false;
    };
    surface.put_rgba(x, y, usize::from(info.width), usize::from(info.height), &pixels);
    true
}
