//! PNG and JPEG encoding of a rectangle of an RGBA framebuffer.

use std::io::Write as _;

/// Copies a rectangle out of a strided RGBA buffer. With `alpha` false the
/// result is packed RGB, which PNG and JPEG both store smaller.
pub fn extract(data: &[u8], stride: usize, x: usize, y: usize, w: usize, h: usize, alpha: bool) -> Vec<u8> {
    let bpp = if alpha { 4 } else { 3 };
    let mut out = Vec::with_capacity(w * h * bpp);
    for row in y..y + h {
        let start = row * stride + x * 4;
        let line = &data[start..start + w * 4];
        if alpha {
            out.extend_from_slice(line);
        } else {
            for px in line.chunks_exact(4) {
                out.extend_from_slice(&px[..3]);
            }
        }
    }
    out
}

pub fn png(data: &[u8], stride: usize, x: usize, y: usize, w: usize, h: usize, alpha: bool) -> Vec<u8> {
    let pixels = extract(data, stride, x, y, w, h, alpha);
    let mut out = Vec::with_capacity(pixels.len() / 4 + 64);
    {
        let mut encoder = png::Encoder::new(&mut out, w as u32, h as u32);
        encoder.set_color(if alpha { png::ColorType::Rgba } else { png::ColorType::Rgb });
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        encoder.set_filter(png::Filter::Adaptive);
        let Ok(mut writer) = encoder.write_header() else {
            return Vec::new();
        };
        if writer.write_image_data(&pixels).is_err() {
            return Vec::new();
        }
        let _ = writer.finish();
    }
    out
}

pub fn jpeg(data: &[u8], stride: usize, x: usize, y: usize, w: usize, h: usize, quality: u8) -> Vec<u8> {
    let pixels = extract(data, stride, x, y, w, h, false);
    let mut out = Vec::with_capacity(pixels.len() / 8 + 1024);
    let encoder = jpeg_encoder::Encoder::new(&mut out, quality.clamp(10, 100));
    if encoder
        .encode(&pixels, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
        .is_err()
    {
        return Vec::new();
    }
    let _ = out.flush();
    out
}
