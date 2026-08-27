//! 付箋内の画像に対する「開く」「Finder で表示」「コピー」の実処理。
//! パスの検証・実在確認は `persistence::resolve_existing_image_path` に委ねる。

use std::io::Cursor;
use std::path::Path;

use image::{ImageReader, Limits};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::persistence::resolve_existing_image_path;

/// デコード時の上限。貼り付け画像は `MAX_IMAGE_BYTES`（10MB）止まりだが、伸張後の
/// メモリ確保と画素数はバイト数と別に制限しないと、小さいファイルでも巨大な
/// ビットマップに展開される画像爆弾（decompression bomb）を防げない
const MAX_DECODE_ALLOC_BYTES: u64 = 128 * 1024 * 1024;
const MAX_IMAGE_DIMENSION: u32 = 20_000;

/// 画像を OS の既定アプリで開く。
pub(crate) fn open_image(app: &AppHandle, data_dir: &Path, rel_path: &str) -> Result<(), String> {
    let full = resolve_existing_image_path(data_dir, rel_path)?;
    app.opener()
        .open_path(full.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// 画像を Finder で選択状態で表示する。
pub(crate) fn reveal_image_in_finder(
    app: &AppHandle,
    data_dir: &Path,
    rel_path: &str,
) -> Result<(), String> {
    let full = resolve_existing_image_path(data_dir, rel_path)?;
    app.opener()
        .reveal_item_in_dir(full)
        .map_err(|e| e.to_string())
}

/// 画像ファイルのバイト列を RGBA8 にデコードする。`copy_image_to_clipboard` と
/// テストから共有するために切り出している（クリップボード書き込み自体はテストできないため）。
pub(crate) fn decode_image_rgba(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);
    reader.limits(limits);
    let img = reader.decode().map_err(|e| e.to_string())?;
    let rgba = img.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok((width, height, rgba.into_raw()))
}

/// 画像をクリップボードに RGBA 画像として書き込む。
///
/// `tauri-plugin-clipboard-manager` ではなく `arboard` を直接使う。
/// 公式プラグインは macOS で NSPasteboard をメインスレッド外から操作してクラッシュする
/// 報告（tauri-apps/plugins-workspace#3205）があり、メニューイベントハンドラ
/// （メインスレッドで同期的に走る）から直接呼べる arboard の方が安全なため。
pub(crate) fn copy_image_to_clipboard(data_dir: &Path, rel_path: &str) -> Result<(), String> {
    let full = resolve_existing_image_path(data_dir, rel_path)?;
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    let (width, height, rgba) = decode_image_rgba(&bytes)?;
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: rgba.into(),
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// テスト用の 1x1 PNG バイト列。`image` クレート自身でエンコードして作る
    /// （手書きのマジックバイトだけでは `load_from_memory` を通せないため）。
    fn tiny_png_bytes() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(1, 1, image::Rgba([10, 20, 30, 255]));
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        bytes
    }

    // ── decode_image_rgba ────────────────────────────────────

    #[test]
    fn decode_image_rgba_decodes_valid_png() {
        let (width, height, rgba) = decode_image_rgba(&tiny_png_bytes()).unwrap();
        assert_eq!((width, height), (1, 1));
        assert_eq!(rgba, vec![10, 20, 30, 255]);
    }

    #[test]
    fn decode_image_rgba_rejects_unsupported_data() {
        assert!(decode_image_rgba(b"not an image").is_err());
    }

    // ── copy_image_to_clipboard: パス検証部分 ──────────────────
    // クリップボードへの実書き込みは CI 環境で検証できないため、その手前の
    // resolve_existing_image_path 呼び出しがエラーになる経路だけを確認する。

    #[test]
    fn copy_image_to_clipboard_rejects_invalid_path() {
        let dir = TempDir::new().unwrap();
        let result = copy_image_to_clipboard(dir.path(), "images/../notes.json");
        assert!(result.is_err());
    }

    #[test]
    fn copy_image_to_clipboard_rejects_missing_file() {
        let dir = TempDir::new().unwrap();
        let result = copy_image_to_clipboard(
            dir.path(),
            "images/00000000-0000-4000-8000-000000000001.png",
        );
        assert!(result.is_err());
    }

    #[test]
    fn open_image_rejects_invalid_path() {
        // AppHandle が要る経路には到達しない（resolve が先に失敗する）ため、
        // ここでは resolve_existing_image_path 単体で検証する
        let dir = TempDir::new().unwrap();
        assert!(resolve_existing_image_path(dir.path(), "images/../notes.json").is_err());
    }

    #[test]
    fn resolve_existing_image_path_accepts_existing_valid_file() {
        let dir = TempDir::new().unwrap();
        let images = dir.path().join("images");
        fs::create_dir_all(&images).unwrap();
        let rel = "images/00000000-0000-4000-8000-000000000001.png";
        fs::write(dir.path().join(rel), tiny_png_bytes()).unwrap();

        let resolved = resolve_existing_image_path(dir.path(), rel).unwrap();
        assert_eq!(resolved, dir.path().join(rel));
    }

    /// `images/` 配下に置かれたシンボリックリンクは、リンク先が実ファイルでも拒否する。
    /// data_dir の外を指すリンク経由でファイルを開いたりコピーしたりできないようにする防御。
    #[test]
    fn resolve_existing_image_path_rejects_symlink() {
        let dir = TempDir::new().unwrap();
        let images = dir.path().join("images");
        fs::create_dir_all(&images).unwrap();
        let target = dir.path().join("outside.png");
        fs::write(&target, tiny_png_bytes()).unwrap();
        let rel = "images/00000000-0000-4000-8000-000000000001.png";
        std::os::unix::fs::symlink(&target, dir.path().join(rel)).unwrap();

        assert!(resolve_existing_image_path(dir.path(), rel).is_err());
    }
}
