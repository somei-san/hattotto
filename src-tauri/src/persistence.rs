use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use uuid::Uuid;

use crate::model::{is_valid_default_color, AppState, Note, Settings, TRASH_MAX};

/// ファイル読み込みの結果。「無い」「読めた」「あるが読めない」を区別する。
/// `Vec<Note>` の `Default` が空であるのと同じ形になってしまう `Unreadable` を
/// `Missing` と混同すると、読み込み失敗を初回起動と誤認して既存データを上書きしうる。
pub(crate) enum Loaded<T> {
    /// ファイルが存在しない。初回起動として扱ってよい
    Missing,
    Ok(T),
    /// ファイルはあるが読み取り・パースに失敗した。上書き保存してはいけない。
    /// 理由文字列はログ用（io / serde エラーの `to_string()`）。ファイルの内容は含まない
    Unreadable(String),
}

// ── Persistence ─────────────────────────────────────────────

pub(crate) fn data_dir() -> PathBuf {
    let dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.hattotto.app");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn data_file(dir: &Path) -> PathBuf {
    dir.join("notes.json")
}

fn settings_file(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

fn trash_file(dir: &Path) -> PathBuf {
    dir.join("trash.json")
}

fn images_dir(dir: &Path) -> PathBuf {
    dir.join("images")
}

/// tmp へ書き、fsync してから rename する。
///
/// rename の永続化までは保証しない。電源断で rename が失われても残るのは完全な旧ファイルで、
/// 失うのは直前の保存 1 回分だけなので、中途半端な内容のファイルにはならない。
///
/// tmp 名は書き込みごとには変えない。クラッシュで残った tmp が溜まるのを避けるためで、
/// 使い回しても衝突しないのは、プロセス ID で他プロセスと分かれ、同一プロセス内では
/// Tauri コマンドがメインスレッドで直列に実行されるからである。
fn atomic_write(path: &Path, data: &str) -> Result<(), String> {
    // 保存先ディレクトリが起動後に消されても、次の保存で作り直して復帰できるようにする。
    // 作成に失敗しても直後の File::create が理由付きで失敗するので、ここでは握り潰す
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_file_name(format!(
        "{}.tmp.{}",
        path.file_name().unwrap().to_string_lossy(),
        std::process::id()
    ));
    let written = (|| -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data.as_bytes())?;
        // Apple プラットフォームでは F_FULLFSYNC になり、ディスクのキャッシュまで書き出す
        f.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{}: {}", tmp.display(), e));
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename {} -> {}: {}", tmp.display(), path.display(), e)
    })
}

fn load_json<T: DeserializeOwned>(path: &Path) -> Loaded<T> {
    // `Path::exists()` は I/O エラーでも false を返すため、故障中のディスクを
    // 「ファイルが無い」と誤認する。`Missing` に倒せるのは NotFound のときだけ
    match fs::metadata(path) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Loaded::Missing,
        Err(e) => return Loaded::Unreadable(e.to_string()),
    }
    match fs::read_to_string(path) {
        Ok(s) => match serde_json::from_str(&s) {
            Ok(v) => Loaded::Ok(v),
            // serde エラーの Display はファイル内の文字列値を逐語で含みうる
            // （付箋本文がログに漏れる）ため、種別と位置だけを残す
            Err(e) => Loaded::Unreadable(format!(
                "{:?} error at line {} column {}",
                e.classify(),
                e.line(),
                e.column()
            )),
        },
        Err(e) => Loaded::Unreadable(e.to_string()),
    }
}

fn save_json<T: serde::Serialize + ?Sized>(
    data: &T,
    path: &Path,
    label: &str,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    atomic_write(path, &json).map_err(|e| format!("Failed to save {}: {}", label, e))
}

fn load_notes_from(path: &Path) -> Loaded<Vec<Note>> {
    load_json(path)
}

pub(crate) fn load_notes(dir: &Path) -> Loaded<Vec<Note>> {
    load_notes_from(&data_file(dir))
}

fn save_notes_to(notes: &[Note], path: &Path) -> Result<(), String> {
    save_json(notes, path, "notes")
}

/// 起動時に 1 つでも読めなかったファイルがあれば `Err` を返す。読めなかった元データを
/// 空データや既定値で上書きしないためのガード。
///
/// ファイル単位で許すと、読めたファイルだけが更新されてファイル間の対応が崩れる。
/// notes.json だけが書ける状態で付箋を削除すると、付箋一覧からは消えるのに
/// ゴミ箱には入らない。
fn refuse_if_unloaded(state: &AppState) -> Result<(), String> {
    if state.notes_loaded && state.settings_loaded && state.trash_loaded {
        return Ok(());
    }
    Err("Refusing to save: a data file failed to load at startup".to_string())
}

pub(crate) fn save_notes(state: &AppState, notes: &[Note]) -> Result<(), String> {
    refuse_if_unloaded(state)?;
    save_notes_to(notes, &data_file(&state.data_dir))
}

fn load_settings_from(path: &Path) -> Loaded<Settings> {
    match load_json::<Settings>(path) {
        Loaded::Ok(mut s) => {
            // 未知の `language` を `Auto` に倒すのと同じ方針で、手編集などで壊れた
            // `default_color` も既定色に倒し、不正値のまま付箋が作られるのを防ぐ
            if !is_valid_default_color(&s.default_color) {
                s.default_color = Settings::default().default_color;
            }
            Loaded::Ok(s)
        }
        other => other,
    }
}

pub(crate) fn load_settings(dir: &Path) -> Loaded<Settings> {
    load_settings_from(&settings_file(dir))
}

fn save_settings_to(settings: &Settings, path: &Path) -> Result<(), String> {
    save_json(settings, path, "settings")
}

pub(crate) fn save_settings(state: &AppState, settings: &Settings) -> Result<(), String> {
    refuse_if_unloaded(state)?;
    save_settings_to(settings, &settings_file(&state.data_dir))
}

fn load_trash_from(path: &Path) -> Loaded<Vec<Note>> {
    load_json(path)
}

pub(crate) fn load_trash(dir: &Path) -> Loaded<Vec<Note>> {
    load_trash_from(&trash_file(dir))
}

fn save_trash_to(trash: &[Note], path: &Path) -> Result<(), String> {
    save_json(trash, path, "trash")
}

pub(crate) fn save_trash(state: &AppState, trash: &[Note]) -> Result<(), String> {
    refuse_if_unloaded(state)?;
    save_trash_to(trash, &trash_file(&state.data_dir))
}

/// ゴミ箱のFIFO制限: TRASH_MAXを超えた分を先頭から削除し、削除した付箋を返す。
/// 呼び出し元はこれを使って、その付箋が参照していた画像の GC 候補を判定する。
#[must_use]
pub(crate) fn enforce_trash_limit(trash: &mut Vec<Note>) -> Vec<Note> {
    let overflow = trash.len().saturating_sub(TRASH_MAX);
    if overflow > 0 {
        trash.drain(0..overflow).collect()
    } else {
        Vec::new()
    }
}

// ── Pasted Images ───────────────────────────────────────────

/// クリップボード画像の許容上限（10MB）。これを超えるペイロードは保存しない。
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// 対応する画像形式の拡張子一覧。`is_valid_image_rel_path` の形状チェックと対応させる。
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

/// 先頭バイト（マジックバイト）から画像形式を判定し、拡張子を返す。
/// 対応外の形式（TIFF 等）は `None`。WKWebView は TIFF を `<img>` として描画できないため対応しない。
fn detect_image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// `save_pasted_image` が生成する相対パスの形状（`images/<uuid v4>.<ext>`）と一致するか検証する。
/// content からの抽出時・GC の削除直前・フロントエンドの asset URL 変換時、いずれもこの形状
/// だけを許可する。`images/../notes.json` のようなパストラバーサルを塞ぐための唯一の関所。
pub(crate) fn is_valid_image_rel_path(path: &str) -> bool {
    let Some(name) = path.strip_prefix("images/") else {
        return false;
    };
    // 単一パスコンポーネントであること（`/`・`\` を含まない = 親ディレクトリへ抜けられない）
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return false;
    }
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    uuid::Uuid::parse_str(stem).is_ok()
        && IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str())
}

/// 相対パスを検証したうえで `data_dir` と結合し、実在確認まで済ませた絶対パスを返す。
/// 「画像を開く」「Finder で表示」「画像をコピー」の 3 コマンド共通の関所で、
/// `is_valid_image_rel_path` の形状チェックに加えてファイルの実在も確認する。
pub(crate) fn resolve_existing_image_path(dir: &Path, rel_path: &str) -> Result<PathBuf, String> {
    if !is_valid_image_rel_path(rel_path) {
        return Err(format!("invalid image path: {}", rel_path));
    }
    let full = dir.join(rel_path);
    // シンボリックリンクは追わない。`images/` 配下に細工したリンクを置かれても、
    // リンク先が data_dir の外を指す実ファイルを開いたりコピーしたりできないようにする
    let is_regular_file = full
        .symlink_metadata()
        .map(|m| m.is_file())
        .unwrap_or(false);
    if !is_regular_file {
        return Err(format!("image not found: {}", full.display()));
    }
    Ok(full)
}

/// クリップボード画像を `images/<uuid v4>.<ext>` として保存し、相対パスを返す。
/// 拡張子はマジックバイトから判定する（クライアントの MIME 型は信用しない）。
pub(crate) fn save_pasted_image(dir: &Path, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "image too large: {} bytes (max {} bytes)",
            bytes.len(),
            MAX_IMAGE_BYTES
        ));
    }
    let ext = detect_image_ext(bytes).ok_or_else(|| "unsupported image format".to_string())?;
    let images = images_dir(dir);
    fs::create_dir_all(&images).map_err(|e| format!("Failed to create images dir: {}", e))?;
    let filename = format!("{}.{}", Uuid::new_v4(), ext);
    fs::write(images.join(&filename), bytes).map_err(|e| format!("Failed to save image: {}", e))?;
    Ok(format!("images/{}", filename))
}

/// content 中の `![alt](images/...)` が参照する相対パス（`images/...`）を抽出する。
/// `is_valid_image_rel_path` の形状に一致するものだけを採用し、パストラバーサルを狙った
/// 記法（`images/../notes.json` 等）は候補にすら入れない。
/// Markdown パーサ全体は導入せず、この記法だけを手書きでスキャンする。
pub(crate) fn extract_image_paths(content: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let bytes = content.as_bytes();
    let mut i = 0;
    // `!` と `[` は ASCII なので、一致した位置は常に UTF-8 の文字境界にある
    while i + 1 < bytes.len() {
        if bytes[i] != b'!' || bytes[i + 1] != b'[' {
            i += 1;
            continue;
        }
        let after_alt_start = i + 2;
        let Some(alt_end) = content[after_alt_start..].find(']') else {
            i += 1;
            continue;
        };
        let paren_pos = after_alt_start + alt_end + 1;
        if content.as_bytes().get(paren_pos) != Some(&b'(') {
            i += 1;
            continue;
        }
        let src_start = paren_pos + 1;
        let Some(src_len) = content[src_start..].find(')') else {
            i += 1;
            continue;
        };
        let src = &content[src_start..src_start + src_len];
        if is_valid_image_rel_path(src) {
            paths.push(src.to_string());
        }
        i = src_start + src_len + 1;
    }
    paths
}

/// `line`（前後の空白を除く）が、`rel_path` を指す画像記法 1 個だけで構成されているか。
/// フロントエンドの `isImageOnlyLine`（`src/note-lines.js`）と対になる判定。
fn is_image_only_line(line: &str, rel_path: &str) -> bool {
    let trimmed = line.trim();
    let Some(rest) = trimmed.strip_prefix("![") else {
        return false;
    };
    let Some(alt_end) = rest.find(']') else {
        return false;
    };
    let after_alt = &rest[alt_end + 1..];
    let Some(src_part) = after_alt.strip_prefix('(') else {
        return false;
    };
    let Some(src_end) = src_part.find(')') else {
        return false;
    };
    let (src, tail) = (&src_part[..src_end], &src_part[src_end + 1..]);
    tail.is_empty() && src == rel_path
}

/// `line` 内でバッククォート 1 組（`` `...` ``）に囲まれた区間（開始・終了のバッククォート自身を
/// 含む、バイトオフセットの半開区間）を列挙する。`src/markdown.js` の `inlineMarkdown` が
/// code を先にプレースホルダへ保護してから画像記法を解釈するのと同じ解釈で、この区間内の
/// `![alt](src)` は実際には `<img>` として描画されない（コードスパンの地の文字列のまま）。
/// occurrence の数え方（`strip_image_ref_occurrence` / フロントの `rewriteImageWidth`）を
/// この「実際に描画されるか」に揃えるための下ごしらえ。
fn code_span_ranges(line: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            if let Some(rel_end) = line[i + 1..].find('`') {
                // `[^`]+` 相当（中身が空のペアは対象外）。バッククォート自身を含めて 1 区間とする
                if rel_end > 0 {
                    let end = i + 1 + rel_end + 1;
                    ranges.push((i, end));
                    i = end;
                    continue;
                }
            }
        }
        i += 1;
    }
    ranges
}

fn is_in_code_span(ranges: &[(usize, usize)], pos: usize) -> bool {
    ranges.iter().any(|&(start, end)| pos >= start && pos < end)
}

/// `line` 内で `rel_path` を参照する `![alt](rel_path)` のうち、`occurrence` 番目（0 始まり、
/// 行内での出現順。コードスパン内の記法は数えない）だけを取り除いた文字列を返す。同じパスの
/// 他の出現・他の画像には触れない。`occurrence` 番目が実在しなければ `None`（unchanged）。
/// `extract_image_paths` と同じ手書きスキャンで、対象区間だけを飛ばして出力を組み立てる。
fn strip_image_ref_occurrence(line: &str, rel_path: &str, occurrence: usize) -> Option<String> {
    let code_spans = code_span_ranges(line);
    let mut out = String::with_capacity(line.len());
    let mut seen = 0usize;
    let mut removed = false;
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < line.len() {
        // `!` と `[` は ASCII なので、一致した位置は常に UTF-8 の文字境界にある
        if !is_in_code_span(&code_spans, i)
            && i + 1 < bytes.len()
            && bytes[i] == b'!'
            && bytes[i + 1] == b'['
        {
            let after_alt_start = i + 2;
            if let Some(alt_end) = line[after_alt_start..].find(']') {
                let paren_pos = after_alt_start + alt_end + 1;
                if line.as_bytes().get(paren_pos) == Some(&b'(') {
                    let src_start = paren_pos + 1;
                    if let Some(src_len) = line[src_start..].find(')') {
                        let src = &line[src_start..src_start + src_len];
                        if src == rel_path {
                            if seen == occurrence {
                                removed = true;
                                seen += 1;
                                i = src_start + src_len + 1;
                                continue;
                            }
                            seen += 1;
                        }
                    }
                }
            }
        }
        let ch = line[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    removed.then_some(out)
}

/// content の `line_idx` 行目（0 始まり）にある、`rel_path` を参照する `occurrence` 番目
/// （0 始まり、行内での出現順）の画像記法だけを取り除く。行全体が画像のみ（前後空白のみ）
/// なら行ごと取り除く（画像のみの行は記法が 1 個しかないので `occurrence` は必ず 0）。
///
/// クリックされた 1 箇所だけを対象にする（フロント側の `imageOccurrenceInLine` /
/// `rewriteImageWidth` と同じ考え方）。同じ画像を指す他の行・他の occurrence には触れない
/// ため、コードフェンス内に同じ記法がテキストとして出現していても巻き込まれない。1 箇所だけ
/// 残しても、その参照が残っている限り `gc_images` は正しくファイルを保持する（孤児化しない）。
///
/// `line_idx` が範囲外、または `occurrence` 番目が実在しない（呼び出し元の状態が content の
/// 現在値とずれている等）場合は `None`。
pub(crate) fn remove_image_occurrence_from_content(
    content: &str,
    rel_path: &str,
    line_idx: usize,
    occurrence: usize,
) -> Option<String> {
    let lines: Vec<&str> = content.split('\n').collect();
    let line = *lines.get(line_idx)?;
    if is_image_only_line(line, rel_path) {
        if occurrence != 0 {
            return None;
        }
        let mut out = lines;
        out.remove(line_idx);
        return Some(out.join("\n"));
    }
    let stripped = strip_image_ref_occurrence(line, rel_path, occurrence)?;
    let mut out: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    out[line_idx] = stripped;
    Some(out.join("\n"))
}

/// notes / trash の全 content が参照している画像相対パスの集合。
fn referenced_image_paths(notes: &[Note], trash: &[Note]) -> HashSet<String> {
    notes
        .iter()
        .chain(trash.iter())
        .flat_map(|n| extract_image_paths(&n.content))
        .collect()
}

/// GC 候補パスのうち、notes / trash のどこからも参照されなくなったものだけ削除する。
/// 削除失敗は致命的ではないので warn ログに残すだけで処理は続ける。
pub(crate) fn gc_images(data_dir: &Path, candidates: &[String], notes: &[Note], trash: &[Note]) {
    if candidates.is_empty() {
        return;
    }
    let referenced = referenced_image_paths(notes, trash);
    for path in candidates {
        // candidates は呼び出し元が extract_image_paths で作るので既に形状検証済みのはずだが、
        // 削除という不可逆操作の直前でもう一段検証する（多層防御）
        if !is_valid_image_rel_path(path) || referenced.contains(path) {
            continue;
        }
        let full = data_dir.join(path);
        if let Err(e) = fs::remove_file(&full) {
            if e.kind() != io::ErrorKind::NotFound {
                log::warn!("failed to remove orphaned image {}: {}", full.display(), e);
            }
        }
    }
}

/// 起動時スイープを実行してよいか。`*_loaded` は「ロードに失敗していない」（Ok または
/// Missing）、`*_source_ok` は「実ファイルから読めた」（Ok のみ）。
///
/// false になるのは (1) どちらかが Unreadable（読めなかった側の参照が集合から欠け、
/// 参照中ファイルを全消ししうる）、(2) 両方とも実ファイルが無い（初回起動なら `images/`
/// も空だが、データ移行途中なら `images/` だけ残っている可能性がある）とき。片方だけ
/// Missing（例: ゴミ箱を一度も使っておらず trash.json が無い）は正常な状態なので true。
/// スキップしたときのコストは孤児が残るだけで、次回起動時にまた判定される
pub(crate) fn should_sweep_images(
    notes_loaded: bool,
    trash_loaded: bool,
    notes_source_ok: bool,
    trash_source_ok: bool,
) -> bool {
    notes_loaded && trash_loaded && (notes_source_ok || trash_source_ok)
}

/// 大文字小文字を無視した比較用に正規化する。`images/` 配下は uuid v4 の hex 部と
/// 拡張子（`is_valid_image_rel_path` は大文字も許容する）で構成され非 ASCII を含まないため
/// `to_ascii_lowercase` で足りる。
fn normalize_image_rel_path(path: &str) -> String {
    path.to_ascii_lowercase()
}

/// 起動時に呼ぶ全孤児スイープ。`images/` を走査し、uuid + 許可拡張子の形状
/// （`is_valid_image_rel_path`）に合うファイルのうち notes / trash のどこからも
/// 参照されていないものを削除する。形状に合わないファイルには触らない。
///
/// `delete_image_data` は画像削除のたびには GC せず、この起動時スイープに一本化している。
/// undo は JS 側ウィンドウローカルの履歴でアプリ終了と共に消えるため、起動した時点で
/// 未参照のファイルはその後もう二度と参照されない。即時 GC と違い、undo で参照が復活する
/// 前にファイルが消えている、という壊れ方が起きない。
///
/// 呼び出し元は `should_sweep_images` で「参照集合が信頼できるか」を判定してから呼ぶこと。
/// `images/` が無ければ何もしない。走査・削除の失敗は起動を止めず warn ログに残すだけ。
pub(crate) fn sweep_orphaned_images(data_dir: &Path, notes: &[Note], trash: &[Note]) {
    let images = images_dir(data_dir);
    let entries = match fs::read_dir(&images) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return,
        Err(e) => {
            log::warn!("failed to read images dir {}: {}", images.display(), e);
            return;
        }
    };
    // APFS は大文字小文字を区別しない（が保持はする）ため、content 中の記法と実ファイル名の
    // 大文字小文字が食い違っても同一ファイルを指しうる。正規化してから比較する
    let referenced: HashSet<String> = referenced_image_paths(notes, trash)
        .iter()
        .map(|p| normalize_image_rel_path(p))
        .collect();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("failed to read images dir entry: {}", e);
                continue;
            }
        };
        let rel_path = format!("images/{}", entry.file_name().to_string_lossy());
        if !is_valid_image_rel_path(&rel_path)
            || referenced.contains(&normalize_image_rel_path(&rel_path))
        {
            continue;
        }
        if let Err(e) = fs::remove_file(entry.path()) {
            if e.kind() != io::ErrorKind::NotFound {
                log::warn!(
                    "failed to remove orphaned image {}: {}",
                    entry.path().display(),
                    e
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::LanguageSetting;
    use std::sync::Mutex;
    use std::time::Instant;
    use tempfile::TempDir;

    fn make_note(id: &str, color: &str, content: &str) -> Note {
        Note {
            id: id.to_string(),
            content: content.to_string(),
            color: color.to_string(),
            x: 0.0,
            y: 0.0,
            width: 280.0,
            height: 320.0,
            zoom: 100,
            pinned: false,
            deleted_at: None,
        }
    }

    /// テスト用の `AppState`。ロード済みフラグ以外は使わない。
    fn make_state(
        data_dir: &Path,
        notes_loaded: bool,
        settings_loaded: bool,
        trash_loaded: bool,
    ) -> AppState {
        AppState {
            notes: Mutex::new(Vec::new()),
            settings: Mutex::new(Settings::default()),
            trash: Mutex::new(Vec::new()),
            last_bring_to_front: Mutex::new(Instant::now()),
            context_menu_note_id: Mutex::new(String::new()),
            context_menu_image_path: Mutex::new(None),
            data_dir: data_dir.to_path_buf(),
            notes_loaded,
            settings_loaded,
            trash_loaded,
            notes_load_error: None,
            settings_load_error: None,
            trash_load_error: None,
        }
    }

    fn unwrap_ok<T>(loaded: Loaded<T>) -> T {
        match loaded {
            Loaded::Ok(v) => v,
            _ => panic!("expected Loaded::Ok"),
        }
    }

    // ── Trash FIFO ──

    #[test]
    fn trash_fifo_within_limit() {
        let mut trash: Vec<Note> = (0..TRASH_MAX)
            .map(|i| make_note(&i.to_string(), "yellow", ""))
            .collect();
        let _ = enforce_trash_limit(&mut trash);
        assert_eq!(trash.len(), TRASH_MAX);
    }

    #[test]
    fn trash_fifo_overflow_by_one() {
        let mut trash: Vec<Note> = (0..TRASH_MAX + 1)
            .map(|i| make_note(&i.to_string(), "yellow", ""))
            .collect();
        let _ = enforce_trash_limit(&mut trash);
        assert_eq!(trash.len(), TRASH_MAX);
        // oldest (id "0") should be removed
        assert_eq!(trash[0].id, "1");
    }

    #[test]
    fn trash_fifo_overflow_by_five() {
        let mut trash: Vec<Note> = (0..TRASH_MAX + 5)
            .map(|i| make_note(&i.to_string(), "yellow", ""))
            .collect();
        let _ = enforce_trash_limit(&mut trash);
        assert_eq!(trash.len(), TRASH_MAX);
        assert_eq!(trash[0].id, "5");
        assert_eq!(trash[TRASH_MAX - 1].id, (TRASH_MAX + 4).to_string());
    }

    #[test]
    fn trash_fifo_returns_drained_notes() {
        let mut trash: Vec<Note> = (0..TRASH_MAX + 2)
            .map(|i| make_note(&i.to_string(), "yellow", ""))
            .collect();
        let drained = enforce_trash_limit(&mut trash);
        assert_eq!(drained.len(), 2);
        assert_eq!(drained[0].id, "0");
        assert_eq!(drained[1].id, "1");
    }

    #[test]
    fn trash_fifo_within_limit_drains_nothing() {
        let mut trash: Vec<Note> = (0..TRASH_MAX)
            .map(|i| make_note(&i.to_string(), "yellow", ""))
            .collect();
        assert!(enforce_trash_limit(&mut trash).is_empty());
    }

    // テスト用の有効な uuid 形状パス。1〜9 の連番を末尾に埋め込み、テストごとに使い分ける
    fn uuid_image_path(n: u8) -> String {
        format!("images/00000000-0000-4000-8000-00000000000{}.png", n)
    }

    // ── is_valid_image_rel_path ──

    #[test]
    fn is_valid_image_rel_path_accepts_generated_shape() {
        assert!(is_valid_image_rel_path(&uuid_image_path(1)));
        assert!(is_valid_image_rel_path(
            "images/00000000-0000-4000-8000-000000000001.jpg"
        ));
        assert!(is_valid_image_rel_path(
            "images/00000000-0000-4000-8000-000000000001.jpeg"
        ));
        assert!(is_valid_image_rel_path(
            "images/00000000-0000-4000-8000-000000000001.gif"
        ));
    }

    #[test]
    fn is_valid_image_rel_path_rejects_path_traversal() {
        assert!(!is_valid_image_rel_path("images/../notes.json"));
        assert!(!is_valid_image_rel_path("images/../../etc/passwd"));
        assert!(!is_valid_image_rel_path("images/sub/dir.png"));
        assert!(!is_valid_image_rel_path("images/..\\notes.json"));
    }

    #[test]
    fn is_valid_image_rel_path_rejects_non_uuid_stem() {
        assert!(!is_valid_image_rel_path("images/a.png"));
        assert!(!is_valid_image_rel_path("images/notes.json"));
    }

    #[test]
    fn is_valid_image_rel_path_rejects_unsupported_extension() {
        assert!(!is_valid_image_rel_path(
            "images/00000000-0000-4000-8000-000000000001.tiff"
        ));
        assert!(!is_valid_image_rel_path(
            "images/00000000-0000-4000-8000-000000000001"
        ));
    }

    #[test]
    fn is_valid_image_rel_path_rejects_missing_images_prefix() {
        assert!(!is_valid_image_rel_path(
            "00000000-0000-4000-8000-000000000001.png"
        ));
        assert!(!is_valid_image_rel_path(""));
    }

    // ── extract_image_paths ──

    #[test]
    fn extract_image_paths_finds_single_reference() {
        let path = uuid_image_path(1);
        let content = format!("見出し\n![]({})\n本文", path);
        assert_eq!(extract_image_paths(&content), vec![path]);
    }

    #[test]
    fn extract_image_paths_finds_multiple_references_with_alt() {
        let (p1, p2) = (uuid_image_path(1), uuid_image_path(2));
        let content = format!("![alt1]({}) text ![alt2]({})", p1, p2);
        assert_eq!(extract_image_paths(&content), vec![p1, p2]);
    }

    #[test]
    fn extract_image_paths_finds_reference_with_width_syntax() {
        // `![alt|300](...)` — alt 内の `|` はスキャンに影響しない（alt は最初の `]` までを丸ごと読むだけ）
        let path = uuid_image_path(1);
        let content = format!("![alt|300]({})", path);
        assert_eq!(extract_image_paths(&content), vec![path]);
    }

    #[test]
    fn extract_image_paths_ignores_non_image_links() {
        let content = "[link](https://example.com) and ![alt](https://example.com/pic.png)";
        assert!(extract_image_paths(content).is_empty());
    }

    #[test]
    fn extract_image_paths_empty_content_returns_empty() {
        assert!(extract_image_paths("").is_empty());
    }

    #[test]
    fn extract_image_paths_does_not_panic_on_multibyte_content() {
        let path = uuid_image_path(1);
        let content = format!("日本語のテキスト ![説明]({}) さらに続く文章", path);
        let found = extract_image_paths(&content);
        assert_eq!(found, vec![path]);
    }

    /// パストラバーサル細工（issue で指摘された `images/../notes.json` 系）は候補にすら
    /// 入らない。extract_image_paths → gc_images の両方が同じ `is_valid_image_rel_path`
    /// を通るため、ここで弾ければ GC の削除対象にもならない。
    #[test]
    fn extract_image_paths_rejects_path_traversal_payload() {
        let content = "![](images/../notes.json)";
        assert!(extract_image_paths(content).is_empty());
    }

    #[test]
    fn extract_image_paths_rejects_nested_path_payload() {
        let content = "![](images/../../etc/passwd)";
        assert!(extract_image_paths(content).is_empty());
    }

    #[test]
    fn extract_image_paths_rejects_backslash_traversal_payload() {
        let content = "![](images/..\\notes.json)";
        assert!(extract_image_paths(content).is_empty());
    }

    // ── remove_image_occurrence_from_content ──

    #[test]
    fn remove_image_occurrence_drops_image_only_line_entirely() {
        let path = uuid_image_path(1);
        let content = format!("見出し\n![]({})\n本文", path);
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 1, 0),
            Some("見出し\n本文".to_string())
        );
    }

    #[test]
    fn remove_image_occurrence_drops_image_only_line_with_width_and_alt() {
        let path = uuid_image_path(1);
        let content = format!("前\n  ![説明|300]({})  \n後", path);
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 1, 0),
            Some("前\n後".to_string())
        );
    }

    #[test]
    fn remove_image_occurrence_strips_syntax_only_from_mixed_line() {
        let path = uuid_image_path(1);
        let content = format!("テキスト ![]({}) の続き", path);
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 0),
            Some("テキスト  の続き".to_string())
        );
    }

    /// クリックされた 1 箇所だけを取り除く。同じパスを参照する他の行はそのまま残る
    /// 同じパスを参照する他の行・他の出現はそのまま残る。
    #[test]
    fn remove_image_occurrence_touches_only_the_targeted_line() {
        let path = uuid_image_path(1);
        let content = format!("![]({})\nテキスト ![別alt]({}) 続き", path, path);

        // 1 行目（image-only）を対象にすると、1 行目だけが丸ごと消え 2 行目は無傷
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 0),
            Some(format!("テキスト ![別alt]({}) 続き", path))
        );
        // 2 行目を対象にすると、2 行目の記法だけが消え 1 行目は無傷
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 1, 0),
            Some(format!("![]({})\nテキスト  続き", path))
        );
    }

    /// 同じ行に同じパスの画像が複数あっても、occurrence で指定した 1 個だけを取り除く。
    #[test]
    fn remove_image_occurrence_targets_only_the_specified_occurrence_in_a_line() {
        let path = uuid_image_path(1);
        let content = format!("![]({}) 通常 ![別alt]({})", path, path);

        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 0),
            Some(format!(" 通常 ![別alt]({})", path))
        );
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 1),
            Some(format!("![]({}) 通常 ", path))
        );
    }

    /// コードフェンス内に同じ画像記法がテキストとして出現していても巻き込まれない
    /// （行・occurrence 単位で 1 箇所だけを対象にするため）。
    #[test]
    fn remove_image_occurrence_does_not_touch_identical_syntax_inside_code_fence() {
        let path = uuid_image_path(1);
        let content = format!("```\n![]({})\n```\ntext ![]({}) here", path, path);

        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 3, 0),
            Some(format!("```\n![]({})\n```\ntext  here", path))
        );
    }

    /// 同じ行にコードスパン（`` `...` ``）内の画像記法もどきと実画像が同居していても、
    /// コードスパン内は occurrence に数えない（実際に <img> として描画されるものだけを数える、
    /// フロントの imageOccurrenceInLine と同じ定義に揃える）。
    #[test]
    fn remove_image_occurrence_skips_code_span_when_counting_occurrence() {
        let path = uuid_image_path(1);
        let content = format!("`![]({})` と ![]({})", path, path);

        // occurrence 0 は「実際に描画される」方（コードスパンの外）を指す
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 0),
            Some(format!("`![]({})` と ", path))
        );
        // コードスパン内は数えないので occurrence 1 は存在しない
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 1),
            None
        );
    }

    #[test]
    fn remove_image_occurrence_keeps_other_images_untouched() {
        let (p1, p2) = (uuid_image_path(1), uuid_image_path(2));
        let content = format!("![]({})\n![]({})", p1, p2);
        assert_eq!(
            remove_image_occurrence_from_content(&content, &p1, 0, 0),
            Some(format!("![]({})", p2))
        );
    }

    #[test]
    fn remove_image_occurrence_no_match_in_line_returns_none() {
        let path = uuid_image_path(1);
        let content = "plain text without images".to_string();
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 0),
            None
        );
    }

    #[test]
    fn remove_image_occurrence_out_of_range_line_returns_none() {
        let path = uuid_image_path(1);
        let content = format!("![]({})", path);
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 5, 0),
            None
        );
    }

    /// occurrence が実在しない（呼び出し元が古い content を基に指定した等）場合は
    /// 何も取り除かず None を返す。
    #[test]
    fn remove_image_occurrence_nonexistent_occurrence_returns_none() {
        let path = uuid_image_path(1);
        let content = format!("text ![]({})", path);
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 1),
            None
        );
    }

    /// 行が画像記法だけで構成されていても、occurrence が 0 以外なら（呼び出し元の状態が
    /// ずれている）取り除かない。
    #[test]
    fn remove_image_occurrence_image_only_line_with_nonzero_occurrence_returns_none() {
        let path = uuid_image_path(1);
        let content = format!("![]({})", path);
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 1),
            None
        );
    }

    /// 行が画像記法だけで構成されていても、対象と別のパスなら行ごと消さない。
    #[test]
    fn remove_image_occurrence_image_only_line_of_different_path_untouched() {
        let (p1, p2) = (uuid_image_path(1), uuid_image_path(2));
        let content = format!("![]({})", p1);
        assert_eq!(
            remove_image_occurrence_from_content(&content, &p2, 0, 0),
            None
        );
    }

    #[test]
    fn remove_image_occurrence_sole_image_only_line_becomes_empty_string() {
        let path = uuid_image_path(1);
        let content = format!("![]({})", path);
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 0),
            Some(String::new())
        );
    }

    /// 行全体が前後空白＋画像記法だけなら image-only 行として丸ごと消える
    /// （strip_image_ref_occurrence 側の「混在行の空白だけ残る」経路は通らない）。
    #[test]
    fn remove_image_occurrence_whitespace_padded_image_only_line_is_dropped() {
        let path = uuid_image_path(1);
        let content = format!("  ![]({})  ", path);
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 0),
            Some(String::new())
        );
    }

    #[test]
    fn remove_image_occurrence_does_not_panic_on_multibyte_content() {
        let path = uuid_image_path(1);
        let content = format!("日本語のテキスト ![説明]({}) さらに続く文章", path);
        assert_eq!(
            remove_image_occurrence_from_content(&content, &path, 0, 0),
            Some("日本語のテキスト  さらに続く文章".to_string())
        );
    }

    // ── gc_images ──

    #[test]
    fn gc_images_removes_unreferenced_image() {
        let dir = TempDir::new().unwrap();
        let path = uuid_image_path(1);
        let images = dir.path().join("images");
        fs::create_dir_all(&images).unwrap();
        let filename = path.strip_prefix("images/").unwrap();
        fs::write(images.join(filename), b"data").unwrap();

        gc_images(dir.path(), std::slice::from_ref(&path), &[], &[]);

        assert!(!images.join(filename).exists());
    }

    /// 他の付箋が同じ画像を参照していたら消さない。
    #[test]
    fn gc_images_keeps_image_still_referenced_by_another_note() {
        let dir = TempDir::new().unwrap();
        let path = uuid_image_path(1);
        let images = dir.path().join("images");
        fs::create_dir_all(&images).unwrap();
        let filename = path.strip_prefix("images/").unwrap();
        fs::write(images.join(filename), b"data").unwrap();
        let notes = vec![make_note("a", "yellow", &format!("![]({})", path))];

        gc_images(dir.path(), std::slice::from_ref(&path), &notes, &[]);

        assert!(images.join(filename).exists());
    }

    /// trash 側の参照でも残す。
    #[test]
    fn gc_images_keeps_image_still_referenced_by_trash() {
        let dir = TempDir::new().unwrap();
        let path = uuid_image_path(1);
        let images = dir.path().join("images");
        fs::create_dir_all(&images).unwrap();
        let filename = path.strip_prefix("images/").unwrap();
        fs::write(images.join(filename), b"data").unwrap();
        let trash = vec![make_note("t", "yellow", &format!("![]({})", path))];

        gc_images(dir.path(), std::slice::from_ref(&path), &[], &trash);

        assert!(images.join(filename).exists());
    }

    #[test]
    fn gc_images_missing_file_does_not_error() {
        let dir = TempDir::new().unwrap();
        // ファイルが既に無くても panic しない
        gc_images(dir.path(), &[uuid_image_path(1)], &[], &[]);
    }

    /// 呼び出し元の検証をすり抜けて渡ってきても、削除直前の多層防御で弾かれる
    /// （data_dir の外や notes.json 自体を指すパスは、そもそも削除対象にしない）。
    #[test]
    fn gc_images_defends_against_path_traversal_candidate() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("notes.json"), r#"[{"id":"a"}]"#).unwrap();

        gc_images(dir.path(), &["images/../notes.json".to_string()], &[], &[]);

        assert!(dir.path().join("notes.json").exists());
    }

    // ── sweep_orphaned_images ──

    #[test]
    fn sweep_orphaned_images_removes_unreferenced_file() {
        let dir = TempDir::new().unwrap();
        let path = uuid_image_path(1);
        let images = dir.path().join("images");
        fs::create_dir_all(&images).unwrap();
        let filename = path.strip_prefix("images/").unwrap();
        fs::write(images.join(filename), b"data").unwrap();

        sweep_orphaned_images(dir.path(), &[], &[]);

        assert!(!images.join(filename).exists());
    }

    #[test]
    fn sweep_orphaned_images_keeps_file_referenced_by_notes() {
        let dir = TempDir::new().unwrap();
        let path = uuid_image_path(1);
        let images = dir.path().join("images");
        fs::create_dir_all(&images).unwrap();
        let filename = path.strip_prefix("images/").unwrap();
        fs::write(images.join(filename), b"data").unwrap();
        let notes = vec![make_note("a", "yellow", &format!("![]({})", path))];

        sweep_orphaned_images(dir.path(), &notes, &[]);

        assert!(images.join(filename).exists());
    }

    #[test]
    fn sweep_orphaned_images_keeps_file_referenced_by_trash() {
        let dir = TempDir::new().unwrap();
        let path = uuid_image_path(1);
        let images = dir.path().join("images");
        fs::create_dir_all(&images).unwrap();
        let filename = path.strip_prefix("images/").unwrap();
        fs::write(images.join(filename), b"data").unwrap();
        let trash = vec![make_note("t", "yellow", &format!("![]({})", path))];

        sweep_orphaned_images(dir.path(), &[], &trash);

        assert!(images.join(filename).exists());
    }

    /// uuid + 許可拡張子の形状に合わないファイルには触らない
    /// （`.DS_Store` のような無関係ファイルが images/ に紛れ込んでいても消さない）。
    #[test]
    fn sweep_orphaned_images_ignores_files_with_unexpected_shape() {
        let dir = TempDir::new().unwrap();
        let images = dir.path().join("images");
        fs::create_dir_all(&images).unwrap();
        fs::write(images.join(".DS_Store"), b"data").unwrap();
        fs::write(images.join("readme.txt"), b"data").unwrap();

        sweep_orphaned_images(dir.path(), &[], &[]);

        assert!(images.join(".DS_Store").exists());
        assert!(images.join("readme.txt").exists());
    }

    #[test]
    fn sweep_orphaned_images_missing_dir_does_not_error() {
        let dir = TempDir::new().unwrap();
        // images/ を作らないまま呼んでも panic しない
        sweep_orphaned_images(dir.path(), &[], &[]);
    }

    /// 参照中のファイルと孤児が同じディレクトリに同居していても、孤児だけを消し
    /// 参照中のファイルは残す。
    #[test]
    fn sweep_orphaned_images_removes_only_the_orphan_among_mixed_files() {
        let dir = TempDir::new().unwrap();
        let (referenced_path, orphan_path) = (uuid_image_path(1), uuid_image_path(2));
        let images = dir.path().join("images");
        fs::create_dir_all(&images).unwrap();
        let referenced_filename = referenced_path.strip_prefix("images/").unwrap();
        let orphan_filename = orphan_path.strip_prefix("images/").unwrap();
        fs::write(images.join(referenced_filename), b"data").unwrap();
        fs::write(images.join(orphan_filename), b"data").unwrap();
        let notes = vec![make_note(
            "a",
            "yellow",
            &format!("![]({})", referenced_path),
        )];

        sweep_orphaned_images(dir.path(), &notes, &[]);

        assert!(images.join(referenced_filename).exists());
        assert!(!images.join(orphan_filename).exists());
    }

    /// APFS は大文字小文字を区別しないので、content の記法と実ファイル名で大文字小文字が
    /// 食い違っていても同一ファイルとして残す。
    #[test]
    fn sweep_orphaned_images_matches_reference_case_insensitively() {
        let dir = TempDir::new().unwrap();
        let path = uuid_image_path(1);
        let images = dir.path().join("images");
        fs::create_dir_all(&images).unwrap();
        let filename = path.strip_prefix("images/").unwrap();
        fs::write(images.join(filename), b"data").unwrap();
        // "images/" プレフィックスは `is_valid_image_rel_path` が大文字小文字を区別するので
        // 保ったまま、ファイル名部分（uuid + 拡張子）だけを大文字化する
        let uppercase_path = format!("images/{}", filename.to_ascii_uppercase());
        let notes = vec![make_note(
            "a",
            "yellow",
            &format!("![]({})", uppercase_path),
        )];

        sweep_orphaned_images(dir.path(), &notes, &[]);

        assert!(images.join(filename).exists());
    }

    // ── should_sweep_images ──

    #[test]
    fn should_sweep_images_true_when_both_sources_ok() {
        assert!(should_sweep_images(true, true, true, true));
    }

    #[test]
    fn should_sweep_images_true_when_only_notes_ok() {
        assert!(should_sweep_images(true, true, true, false));
    }

    #[test]
    fn should_sweep_images_true_when_only_trash_ok() {
        assert!(should_sweep_images(true, true, false, true));
    }

    /// 両方 Missing（実ファイルが無い）状態では、データ移行途中の可能性があり
    /// 参照集合を信頼できないため false（消さない）。
    #[test]
    fn should_sweep_images_false_when_neither_source_ok() {
        assert!(!should_sweep_images(true, true, false, false));
    }

    /// どちらかが Unreadable なら、もう一方が読めていても参照集合が欠けているため
    /// false（消さない）。
    #[test]
    fn should_sweep_images_false_when_either_side_unreadable() {
        assert!(!should_sweep_images(false, true, false, true));
        assert!(!should_sweep_images(true, false, true, false));
    }

    // ── save_pasted_image ──

    const PNG_MAGIC: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    const JPEG_MAGIC: &[u8] = &[0xFF, 0xD8, 0xFF];
    const GIF_MAGIC: &[u8] = b"GIF89a";

    #[test]
    fn save_pasted_image_writes_bytes_and_returns_uuid_png_path() {
        let dir = TempDir::new().unwrap();
        let mut bytes = PNG_MAGIC.to_vec();
        bytes.extend_from_slice(b"rest-of-the-fake-png-data");

        let rel_path = save_pasted_image(dir.path(), &bytes).unwrap();

        assert!(is_valid_image_rel_path(&rel_path));
        assert!(rel_path.ends_with(".png"));
        let filename = rel_path.strip_prefix("images/").unwrap();
        assert_eq!(
            fs::read(dir.path().join("images").join(filename)).unwrap(),
            bytes
        );
    }

    #[test]
    fn save_pasted_image_detects_jpeg_extension() {
        let dir = TempDir::new().unwrap();
        let mut bytes = JPEG_MAGIC.to_vec();
        bytes.extend_from_slice(b"rest-of-the-fake-jpeg-data");

        let rel_path = save_pasted_image(dir.path(), &bytes).unwrap();

        assert!(rel_path.ends_with(".jpg"));
        assert!(is_valid_image_rel_path(&rel_path));
    }

    #[test]
    fn save_pasted_image_detects_gif_extension() {
        let dir = TempDir::new().unwrap();
        let mut bytes = GIF_MAGIC.to_vec();
        bytes.extend_from_slice(b"rest-of-the-fake-gif-data");

        let rel_path = save_pasted_image(dir.path(), &bytes).unwrap();

        assert!(rel_path.ends_with(".gif"));
        assert!(is_valid_image_rel_path(&rel_path));
    }

    #[test]
    fn save_pasted_image_detects_webp_extension() {
        let dir = TempDir::new().unwrap();
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&[0x24, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(b"rest-of-the-fake-webp-data");

        let rel_path = save_pasted_image(dir.path(), &bytes).unwrap();

        assert!(rel_path.ends_with(".webp"));
        assert!(is_valid_image_rel_path(&rel_path));
    }

    #[test]
    fn save_pasted_image_rejects_riff_without_webp_marker() {
        let dir = TempDir::new().unwrap();
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&[0x24, 0x00, 0x00, 0x00]);
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"this-is-audio-not-an-image");

        assert!(save_pasted_image(dir.path(), &bytes).is_err());
    }

    #[test]
    fn save_pasted_image_creates_images_dir_if_missing() {
        let dir = TempDir::new().unwrap();
        assert!(!dir.path().join("images").exists());

        save_pasted_image(dir.path(), PNG_MAGIC).unwrap();

        assert!(dir.path().join("images").is_dir());
    }

    #[test]
    fn save_pasted_image_rejects_oversized_payload() {
        let dir = TempDir::new().unwrap();
        let mut bytes = vec![0u8; MAX_IMAGE_BYTES + 1];
        bytes[..PNG_MAGIC.len()].copy_from_slice(PNG_MAGIC);

        let result = save_pasted_image(dir.path(), &bytes);

        assert!(result.is_err());
        assert!(!dir.path().join("images").exists());
    }

    #[test]
    fn save_pasted_image_accepts_payload_at_exactly_the_limit() {
        let dir = TempDir::new().unwrap();
        let mut bytes = vec![0u8; MAX_IMAGE_BYTES];
        bytes[..PNG_MAGIC.len()].copy_from_slice(PNG_MAGIC);

        assert!(save_pasted_image(dir.path(), &bytes).is_ok());
    }

    #[test]
    fn save_pasted_image_rejects_unsupported_format() {
        let dir = TempDir::new().unwrap();
        let bytes = b"BM-this-looks-like-a-bitmap-not-png-jpeg-or-gif".to_vec();

        let result = save_pasted_image(dir.path(), &bytes);

        assert!(result.is_err());
        assert!(!dir.path().join("images").exists());
    }

    #[test]
    fn save_pasted_image_rejects_empty_payload() {
        let dir = TempDir::new().unwrap();
        assert!(save_pasted_image(dir.path(), &[]).is_err());
    }

    // ── JSON persistence roundtrip ──

    #[test]
    fn notes_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.json");
        let notes = vec![
            make_note("a", "yellow", "hello"),
            make_note("b", "blue", "world"),
        ];
        save_notes_to(&notes, &path).unwrap();
        let loaded = unwrap_ok(load_notes_from(&path));
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "a");
        assert_eq!(loaded[0].content, "hello");
        assert_eq!(loaded[1].id, "b");
        assert_eq!(loaded[1].color, "blue");
    }

    #[test]
    fn settings_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        let settings = Settings {
            default_color: "pink".into(),
            opacity: 80,
            bring_all_to_front: false,
            show_pin_button: true,
            show_new_button: true,
            show_color_button: true,
            confirm_before_delete: true,
            language: LanguageSetting::En,
        };
        save_settings_to(&settings, &path).unwrap();
        let loaded = unwrap_ok(load_settings_from(&path));
        assert_eq!(loaded.default_color, "pink");
        assert_eq!(loaded.opacity, 80);
        assert!(!loaded.bring_all_to_front);
        assert!(loaded.confirm_before_delete);
        assert_eq!(loaded.language, LanguageSetting::En);
    }

    #[test]
    fn load_settings_invalid_default_color_falls_back_to_default() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"default_color":"vermilion","opacity":100}"#).unwrap();
        let loaded = unwrap_ok(load_settings_from(&path));
        assert_eq!(loaded.default_color, "yellow");
    }

    #[test]
    fn load_settings_random_default_color_is_kept() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"default_color":"random","opacity":100}"#).unwrap();
        let loaded = unwrap_ok(load_settings_from(&path));
        assert_eq!(loaded.default_color, "random");
    }

    #[test]
    fn trash_roundtrip() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("trash.json");
        let trash = vec![make_note("t1", "green", "deleted")];
        save_trash_to(&trash, &path).unwrap();
        let loaded = unwrap_ok(load_trash_from(&path));
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "t1");
        assert_eq!(loaded[0].content, "deleted");
    }

    // ── Loaded の3状態 ──

    #[test]
    fn load_notes_nonexistent_returns_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");
        assert!(matches!(load_notes_from(&path), Loaded::Missing));
    }

    #[test]
    fn load_settings_nonexistent_returns_missing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");
        assert!(matches!(load_settings_from(&path), Loaded::Missing));
    }

    #[test]
    fn load_notes_valid_json_returns_ok() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.json");
        let notes = vec![make_note("a", "yellow", "hello")];
        save_notes_to(&notes, &path).unwrap();
        let loaded = unwrap_ok(load_notes_from(&path));
        assert_eq!(loaded.len(), 1);
    }

    #[test]
    fn load_notes_broken_json_returns_unreadable() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.json");
        fs::write(&path, r#"{"broken"#).unwrap();
        assert!(matches!(load_notes_from(&path), Loaded::Unreadable(_)));
    }

    #[test]
    fn load_notes_unreadable_permissions_returns_unreadable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let path = dir.path().join("notes.json");
        let notes = vec![make_note("a", "yellow", "hello")];
        save_notes_to(&notes, &path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();

        let result = fs::read_to_string(&path);
        // root や CI コンテナ等、パーミッションが効かない環境では検証不能なのでスキップする
        if result.is_ok() {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            eprintln!(
                "skipping load_notes_unreadable_permissions_returns_unreadable: \
                 this environment ignores file permissions (likely running as root)"
            );
            return;
        }

        assert!(matches!(load_notes_from(&path), Loaded::Unreadable(_)));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    }

    /// ファイルの有無すら確認できない状況を `Missing` に倒さないことの確認。
    /// 親ディレクトリの検索権限を落とすと `Path::exists()` は false を返すので、
    /// この経路を `Missing` にすると故障中のディスクで既存データを上書きしてしまう。
    #[test]
    fn load_notes_unstattable_returns_unreadable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let locked = dir.path().join("locked");
        fs::create_dir(&locked).unwrap();
        let path = locked.join("notes.json");
        save_notes_to(&[make_note("a", "yellow", "hello")], &path).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let unstattable = fs::metadata(&path).is_err();
        let result = load_notes_from(&path);
        // TempDir が後片付けできるよう、判定前に権限を戻す
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();

        // root や CI コンテナ等、パーミッションが効かない環境では検証不能なのでスキップする
        if !unstattable {
            eprintln!(
                "skipping load_notes_unstattable_returns_unreadable: \
                 this environment ignores directory permissions (likely running as root)"
            );
            return;
        }
        assert!(matches!(result, Loaded::Unreadable(_)));
    }

    // ── atomic_write tests ──

    #[test]
    fn atomic_write_creates_file_with_correct_content() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.json");
        atomic_write(&path, r#"{"hello":"world"}"#).unwrap();
        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, r#"{"hello":"world"}"#);
    }

    #[test]
    fn atomic_write_leaves_no_tmp_behind() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.json");
        atomic_write(&path, "first").unwrap();
        atomic_write(&path, "second").unwrap();
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["test.json"]);
    }

    /// 保存先ディレクトリが消えていても作り直して保存できる（自己修復）。
    #[test]
    fn atomic_write_creates_missing_parent_dir() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("no_such_dir").join("file.json");
        atomic_write(&path, "data").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "data");
    }

    // ── save_*_to error path tests ──
    // 親パスを通常ファイルで塞ぐとディレクトリを作れず、保存は失敗する

    #[test]
    fn save_notes_to_blocked_parent_returns_err() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("blocker"), "").unwrap();
        let path = dir.path().join("blocker").join("notes.json");
        let notes = vec![make_note("e1", "yellow", "err")];
        let result = save_notes_to(&notes, &path);
        assert!(result.is_err());
    }

    #[test]
    fn save_settings_to_blocked_parent_returns_err() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("blocker"), "").unwrap();
        let path = dir.path().join("blocker").join("settings.json");
        let result = save_settings_to(&Settings::default(), &path);
        assert!(result.is_err());
    }

    #[test]
    fn save_trash_to_blocked_parent_returns_err() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("blocker"), "").unwrap();
        let path = dir.path().join("blocker").join("trash.json");
        let trash = vec![make_note("t1", "green", "err")];
        let result = save_trash_to(&trash, &path);
        assert!(result.is_err());
    }

    // ── 保存ガード ──

    #[test]
    fn save_notes_refuses_when_not_loaded() {
        let dir = TempDir::new().unwrap();
        let state = make_state(dir.path(), false, true, true);
        let notes = vec![make_note("a", "yellow", "should not be saved")];
        let result = save_notes(&state, &notes);

        assert!(result.is_err());
        assert!(
            !dir.path().join("notes.json").exists(),
            "notes.json must not be created when notes_loaded is false"
        );
    }

    /// 読めなかったのが別のファイルでも保存を止める。
    #[test]
    fn save_notes_refuses_when_another_file_failed_to_load() {
        let dir = TempDir::new().unwrap();
        assert!(refuse_if_unloaded(&make_state(dir.path(), true, false, true)).is_err());
        assert!(refuse_if_unloaded(&make_state(dir.path(), true, true, false)).is_err());
        assert!(refuse_if_unloaded(&make_state(dir.path(), true, true, true)).is_ok());
    }
}
