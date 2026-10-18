//! The Termix remote desktop engine core: an RDP client on IronRDP and the
//! image encoders every protocol shares.

mod clipboard;
mod codec;
mod drive;
mod encode;
mod rail;
mod rdp;
mod sound;
mod surface;

use wasm_bindgen::prelude::*;

pub use rdp::RdpClient;
pub use codec::{decode_jpeg_into, Inflater};
pub use surface::{encode_rgba_png, Surface};

#[wasm_bindgen]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}
