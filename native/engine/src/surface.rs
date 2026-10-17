//! An RGBA framebuffer living in WASM memory. VNC and Telnet draw into it
//! from JS through a view on `ptr()`, then encode the changed rectangles.

use wasm_bindgen::prelude::*;

use crate::encode;

#[wasm_bindgen]
pub struct Surface {
    width: usize,
    height: usize,
    data: Vec<u8>,
}

#[wasm_bindgen]
impl Surface {
    #[wasm_bindgen(constructor)]
    pub fn new(width: usize, height: usize) -> Surface {
        Surface {
            width,
            height,
            data: vec![0; width * height * 4],
        }
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    /// Byte offset of pixel (0, 0) in the module's memory.
    pub fn ptr(&self) -> *const u8 {
        self.data.as_ptr()
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Resizes, keeping the overlapping top-left part.
    pub fn resize(&mut self, width: usize, height: usize) {
        let mut data = vec![0; width * height * 4];
        let w = width.min(self.width);
        for row in 0..height.min(self.height) {
            let src = row * self.width * 4;
            let dst = row * width * 4;
            data[dst..dst + w * 4].copy_from_slice(&self.data[src..src + w * 4]);
        }
        self.width = width;
        self.height = height;
        self.data = data;
    }

    pub fn fill(&mut self, x: usize, y: usize, w: usize, h: usize, rgba: u32) {
        let px = rgba.to_be_bytes();
        let (x, y, w, h) = self.clip(x, y, w, h);
        for row in y..y + h {
            let start = (row * self.width + x) * 4;
            for chunk in self.data[start..start + w * 4].chunks_exact_mut(4) {
                chunk.copy_from_slice(&px);
            }
        }
    }

    /// Moves a rectangle within the surface, like a VNC CopyRect.
    pub fn copy_rect(&mut self, sx: usize, sy: usize, w: usize, h: usize, dx: usize, dy: usize) {
        if sx + w > self.width || dx + w > self.width || sy + h > self.height || dy + h > self.height {
            return;
        }
        let stride = self.width * 4;
        let rows: Box<dyn Iterator<Item = usize>> = if dy > sy {
            Box::new((0..h).rev())
        } else {
            Box::new(0..h)
        };
        for r in rows {
            let src = (sy + r) * stride + sx * 4;
            let dst = (dy + r) * stride + dx * 4;
            self.data.copy_within(src..src + w * 4, dst);
        }
    }

    pub fn encode_png(&self, x: usize, y: usize, w: usize, h: usize, alpha: bool) -> Vec<u8> {
        let (x, y, w, h) = self.clip(x, y, w, h);
        if w == 0 || h == 0 {
            return Vec::new();
        }
        encode::png(&self.data, self.width * 4, x, y, w, h, alpha)
    }

    pub fn encode_jpeg(&self, x: usize, y: usize, w: usize, h: usize, quality: u8) -> Vec<u8> {
        let (x, y, w, h) = self.clip(x, y, w, h);
        if w == 0 || h == 0 {
            return Vec::new();
        }
        encode::jpeg(&self.data, self.width * 4, x, y, w, h, quality)
    }
}

impl Surface {
    /// Writes packed RGBA pixels at (x, y), clipped to the surface.
    pub fn put_rgba(&mut self, x: usize, y: usize, w: usize, h: usize, pixels: &[u8]) {
        let (cx, cy, cw, ch) = self.clip(x, y, w, h);
        if cx != x || cy != y || pixels.len() < w * h * 4 {
            return;
        }
        for row in 0..ch {
            let src = row * w * 4;
            let dst = ((cy + row) * self.width + cx) * 4;
            self.data[dst..dst + cw * 4].copy_from_slice(&pixels[src..src + cw * 4]);
        }
    }

    fn clip(&self, x: usize, y: usize, w: usize, h: usize) -> (usize, usize, usize, usize) {
        let x = x.min(self.width);
        let y = y.min(self.height);
        (x, y, w.min(self.width - x), h.min(self.height - y))
    }
}

/// Encodes raw RGBA pixels (a cursor, a glyph) that are not in a surface.
#[wasm_bindgen]
pub fn encode_rgba_png(pixels: &[u8], width: usize, height: usize) -> Vec<u8> {
    if pixels.len() < width * height * 4 || width == 0 || height == 0 {
        return Vec::new();
    }
    encode::png(pixels, width * 4, 0, 0, width, height, true)
}
