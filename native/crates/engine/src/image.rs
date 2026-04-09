//! Image decode, encode, and resize via N-API.
//!
//! Provides:
//! - Load image from bytes (PNG, JPEG, WebP, GIF)
//! - Get dimensions
//! - Resize with configurable sampling filter
//! - Export as PNG, JPEG, WebP, or GIF

use std::{io::Cursor, sync::Arc};

use image::{
    DynamicImage, ImageFormat, ImageReader,
    codecs::{jpeg::JpegEncoder, webp::WebPEncoder},
    imageops::FilterType,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

/// Sampling filter for resize operations.
#[napi]
pub enum SamplingFilter {
    /// Nearest-neighbor sampling (fast, low quality).
    Nearest    = 1,
    /// Triangle filter (linear interpolation).
    Triangle   = 2,
    /// Catmull-Rom filter with sharper edges.
    CatmullRom = 3,
    /// Gaussian filter for smoother results.
    Gaussian   = 4,
    /// Lanczos3 filter for high-quality downscaling.
    Lanczos3   = 5,
}

impl From<SamplingFilter> for FilterType {
    fn from(filter: SamplingFilter) -> Self {
        match filter {
            SamplingFilter::Nearest => Self::Nearest,
            SamplingFilter::Triangle => Self::Triangle,
            SamplingFilter::CatmullRom => Self::CatmullRom,
            SamplingFilter::Gaussian => Self::Gaussian,
            SamplingFilter::Lanczos3 => Self::Lanczos3,
        }
    }
}

/// Image container for native interop.
#[napi]
pub struct NativeImage {
    img: Arc<DynamicImage>,
}

type ImageTask = task::Async<NativeImage>;

#[napi]
impl NativeImage {
    /// Decode encoded image bytes (PNG, JPEG, WebP, GIF) into a NativeImage.
    #[napi(js_name = "parse")]
    pub fn parse(bytes: Uint8Array) -> ImageTask {
        let bytes = bytes.as_ref().to_vec();
        task::blocking("image.decode", (), move |_| -> Result<Self> {
            let img = decode_image_from_bytes(&bytes)?;
            Ok(Self { img: Arc::new(img) })
        })
    }

    /// Image width in pixels.
    #[napi(getter, js_name = "width")]
    pub fn get_width(&self) -> u32 {
        self.img.width()
    }

    /// Image height in pixels.
    #[napi(getter, js_name = "height")]
    pub fn get_height(&self) -> u32 {
        self.img.height()
    }

    /// Encode to bytes. Format: 0=PNG, 1=JPEG, 2=WebP, 3=GIF.
    #[napi(js_name = "encode")]
    pub fn encode(&self, format: u8, quality: u8) -> task::Async<Vec<u8>> {
        let img = Arc::clone(&self.img);
        task::blocking("image.encode", (), move |_| encode_image(&img, format, quality))
    }

    /// Resize to exact dimensions. Returns a new NativeImage.
    #[napi(js_name = "resize")]
    pub fn resize(&self, width: u32, height: u32, filter: SamplingFilter) -> ImageTask {
        let img = Arc::clone(&self.img);
        task::blocking("image.resize", (), move |_| {
            Ok(Self { img: Arc::new(img.resize_exact(width, height, filter.into())) })
        })
    }
}

fn decode_image_from_bytes(bytes: &[u8]) -> Result<DynamicImage> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| Error::from_reason(format!("Failed to detect image format: {e}")))?;
    reader
        .decode()
        .map_err(|e| Error::from_reason(format!("Failed to decode image: {e}")))
}

/// Compute a capacity hint for the encode buffer using checked arithmetic.
///
/// Returns an error instead of panicking when `w * h * bytes_per_pixel`
/// overflows `usize`.
fn encode_capacity(w: u32, h: u32, bytes_per_pixel: usize) -> Result<usize> {
    (w as usize)
        .checked_mul(h as usize)
        .and_then(|wh| wh.checked_mul(bytes_per_pixel))
        .ok_or_else(|| Error::from_reason("Image dimensions too large for encode buffer"))
}

fn encode_image(img: &DynamicImage, format: u8, quality: u8) -> Result<Vec<u8>> {
    let (w, h) = (img.width(), img.height());
    match format {
        0 => {
            let mut buffer = Vec::with_capacity(encode_capacity(w, h, 4)?);
            img.write_to(&mut Cursor::new(&mut buffer), ImageFormat::Png)
                .map_err(|e| Error::from_reason(format!("Failed to encode PNG: {e}")))?;
            Ok(buffer)
        },
        1 => {
            let mut buffer = Vec::with_capacity(encode_capacity(w, h, 3)?);
            let encoder = JpegEncoder::new_with_quality(&mut buffer, quality);
            img.write_with_encoder(encoder)
                .map_err(|e| Error::from_reason(format!("Failed to encode JPEG: {e}")))?;
            Ok(buffer)
        },
        2 => {
            let mut buffer = Vec::with_capacity(encode_capacity(w, h, 4)?);
            let encoder = WebPEncoder::new_lossless(&mut buffer);
            img.write_with_encoder(encoder)
                .map_err(|e| Error::from_reason(format!("Failed to encode WebP: {e}")))?;
            Ok(buffer)
        },
        3 => {
            let mut buffer = Vec::with_capacity(encode_capacity(w, h, 1)?);
            img.write_to(&mut Cursor::new(&mut buffer), ImageFormat::Gif)
                .map_err(|e| Error::from_reason(format!("Failed to encode GIF: {e}")))?;
            Ok(buffer)
        },
        _ => Err(Error::from_reason(format!("Invalid image format: {format}"))),
    }
}
