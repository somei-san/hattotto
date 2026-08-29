use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use crate::context_menu::build_context_menu;
use crate::i18n::{self, Msg};
use crate::image_actions;
use crate::model::{
    clamp_opacity, clamp_zoom, is_valid_color_key, is_valid_default_color, resolve_color, AppState,
    LanguageSetting, Note, RecoverMutex, Settings, TRASH_MAX,
};
use crate::persistence::{
    self, enforce_trash_limit, extract_image_paths, gc_images,
    remove_image_occurrence_from_content, save_notes, save_settings, save_trash,
};
use crate::window::{
    create_note_with_window, open_note_window, open_settings_window, open_trash_window,
};
use crate::{menu, tray};

// ── Tauri Commands ──────────────────────────────────────────

/// 指定 ID の付箋を検索し、クロージャで更新して保存する。
/// Mutex ガードを早期に解放し、disk I/O 中に他の操作をブロックしない。
fn update_note_field(state: &AppState, id: &str, f: impl FnOnce(&mut Note)) -> Result<(), String> {
    let snapshot = {
        let mut notes = state.notes.recover();
        let note = notes
            .iter_mut()
            .find(|n| n.id == id)
            .ok_or_else(|| format!("note not found: {}", id))?;
        f(note);
        notes.clone()
    };
    save_notes(state, &snapshot)
}

/// 指定 ID の付箋を返す。見つからない場合は `None`。
#[tauri::command]
pub(crate) fn get_note(id: String, state: State<AppState>) -> Option<Note> {
    let notes = state.notes.recover();
    notes.iter().find(|n| n.id == id).cloned()
}

/// 付箋の本文を更新して保存する。
#[tauri::command]
pub(crate) fn update_note_content(
    id: String,
    content: String,
    state: State<AppState>,
) -> Result<(), String> {
    update_note_field(&state, &id, |note| note.content = content)
}

/// 付箋の色を更新して保存する。
#[tauri::command]
pub(crate) fn update_note_color(
    id: String,
    color: String,
    state: State<AppState>,
) -> Result<(), String> {
    let resolved = resolve_color(&color);
    if !is_valid_color_key(&resolved) {
        return Ok(());
    }
    update_note_field(&state, &id, |note| note.color = resolved)
}

/// 付箋のウィンドウ位置・サイズを更新して保存する。
#[tauri::command]
pub(crate) fn update_note_geometry(
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    state: State<AppState>,
) -> Result<(), String> {
    update_note_field(&state, &id, |note| {
        note.x = x;
        note.y = y;
        note.width = width;
        note.height = height;
    })
}

/// 付箋の表示倍率（50〜200%）を更新して保存する。
#[tauri::command]
pub(crate) fn update_note_zoom(
    id: String,
    zoom: u32,
    state: State<AppState>,
) -> Result<(), String> {
    update_note_field(&state, &id, |note| note.zoom = clamp_zoom(zoom))
}

/// 付箋のピン留め状態を更新して保存する。
#[tauri::command]
pub(crate) fn update_note_pinned(
    id: String,
    pinned: bool,
    state: State<AppState>,
) -> Result<(), String> {
    update_note_field(&state, &id, |note| note.pinned = pinned)
}

/// Confirm deletion if setting is enabled. Returns false if user cancelled.
/// 空の付箋（issue #56）は消えて困る中身が無いため、設定に関わらず確認しない。
pub(crate) fn confirm_delete_if_needed(app: &AppHandle, state: &AppState, id: &str) -> bool {
    let is_empty = state
        .notes
        .recover()
        .iter()
        .find(|n| n.id == id)
        .map(Note::is_empty)
        .unwrap_or(false);
    if is_empty {
        return true;
    }
    let (confirm, lang) = {
        let settings = state.settings.recover();
        (
            settings.confirm_before_delete,
            i18n::resolve(settings.language),
        )
    };
    if !confirm {
        return true;
    }
    app.dialog()
        .message(i18n::text(lang, Msg::DeleteConfirmMessage))
        .title(i18n::app_name(lang))
        .buttons(MessageDialogButtons::OkCancelCustom(
            i18n::text(lang, Msg::DeleteConfirmOk).into(),
            i18n::text(lang, Msg::DeleteConfirmCancel).into(),
        ))
        .blocking_show()
}

/// 画像削除の確認。`confirm_before_delete` が有効な場合のみダイアログを出す
/// （無効なら従来どおり即実行）。基盤は `confirm_delete_if_needed` と共通だが、対象が
/// 付箋そのものではなく画像 1 個なので専用の文言（`Msg::DeleteImageConfirmMessage`）を使う。
/// 付箋削除と違って「空なら確認しない」特例は無い（画像の有無と付箋の空判定は無関係）。
pub(crate) fn confirm_delete_image_if_needed(app: &AppHandle, state: &AppState) -> bool {
    let (confirm, lang) = {
        let settings = state.settings.recover();
        (
            settings.confirm_before_delete,
            i18n::resolve(settings.language),
        )
    };
    if !confirm {
        return true;
    }
    app.dialog()
        .message(i18n::text(lang, Msg::DeleteImageConfirmMessage))
        .title(i18n::app_name(lang))
        .buttons(MessageDialogButtons::OkCancelCustom(
            i18n::text(lang, Msg::DeleteConfirmOk).into(),
            i18n::text(lang, Msg::DeleteConfirmCancel).into(),
        ))
        .blocking_show()
}

/// 付箋をゴミ箱へ移動する（メモリ上の移動＋保存のみ。ウィンドウは操作しない）。
/// 該当 id の付箋があったかどうかを返す。
///
/// 移動後の notes / trash を計算してから保存し、1 本目 (trash.json) が成功して
/// はじめてメモリへ反映する。1 本目が失敗した時点ではメモリはまだ計算前のままなので
/// 呼び出し元は無傷な状態で Err を受け取る。2 本目 (notes.json) の失敗はメモリを
/// 戻さない。メモリは意図した最終状態にあり、ディスクは両方のファイルに付箋が
/// 残っているので次に成功した保存で収束する。
pub(crate) fn delete_note_data(state: &AppState, id: &str) -> Result<bool, String> {
    let (notes_snapshot, mut note) = {
        let notes = state.notes.recover();
        let Some(pos) = notes.iter().position(|n| n.id == id) else {
            return Ok(false);
        };
        let mut notes_snap = notes.clone();
        drop(notes);
        let note = notes_snap.remove(pos);
        (notes_snap, note)
    };

    // 空の付箋（issue #56）は消えて困る中身が無いので、ゴミ箱に入れず notes から取り除くだけにする
    if note.is_empty() {
        // 保存が途中で止まって同じ id がゴミ箱にも残っている場合は、その残骸も一緒に
        // 掃除する（掃除しないと空の付箋がゴミ箱に残り続ける）。書き込み順は非空の
        // 削除と同じ trash 先行
        let stale_trash = {
            let trash = state.trash.recover();
            trash.iter().any(|n| n.id == id).then(|| {
                let mut snap = trash.clone();
                snap.retain(|n| n.id != id);
                snap
            })
        };
        if let Some(ts) = &stale_trash {
            save_trash(state, ts)?;
            *state.trash.recover() = ts.clone();
        }
        save_notes(state, &notes_snapshot)?;
        *state.notes.recover() = notes_snapshot;
        // 画像記法を含む content は空白のみにならず、この分岐には来ないため画像 GC は不要
        return Ok(true);
    }

    let (trash_snapshot, drained) = {
        note.deleted_at = Some(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        );
        let mut trash_snap = state.trash.recover().clone();
        // 保存が途中で止まって付箋とゴミ箱の両方に残った付箋を再度削除しても
        // ゴミ箱に同じ id が並ばないようにする
        trash_snap.retain(|n| n.id != id);
        trash_snap.push(note);
        let drained = enforce_trash_limit(&mut trash_snap);
        (trash_snap, drained)
    };
    // 付箋側を先に消すと、間で中断したときにどちらのファイルからも消える。
    // この順なら両方に残るので捨て直せる
    save_trash(state, &trash_snapshot)?;
    // スナップショットで丸ごと差し替える。計算と反映の間に notes / trash を書く
    // 経路が並行して走ると更新が消えるため、コマンドのメインスレッド直列実行が前提
    *state.notes.recover() = notes_snapshot.clone();
    *state.trash.recover() = trash_snapshot.clone();
    save_notes(state, &notes_snapshot)?;
    // FIFO で溢れて完全に消えた付箋（trash からも drop 済み）が参照していた画像を GC する
    let candidates: Vec<String> = drained
        .iter()
        .flat_map(|n| extract_image_paths(&n.content))
        .collect();
    if !candidates.is_empty() {
        gc_images(
            &state.data_dir,
            &candidates,
            &notes_snapshot,
            &trash_snapshot,
        );
    }
    Ok(true)
}

/// Move a note to trash and close its window.
pub(crate) fn do_delete_note(id: &str, app: &AppHandle, state: &AppState) -> Result<(), String> {
    match delete_note_data(state, id) {
        Ok(_) => {
            if let Some(win) = app.get_webview_window(&format!("note-{}", id)) {
                let _ = win.close();
            }
            Ok(())
        }
        Err(e) => {
            // 2 本目の保存 (notes.json) が失敗した場合、メモリの notes からは既に
            // 消えている。ウィンドウを残すとオートセーブが note not found で失敗し
            // 続けるので、メモリの状態を見てウィンドウを閉じる。1 本目の失敗では
            // メモリは無傷なのでウィンドウは残す
            let still_in_notes = state.notes.recover().iter().any(|n| n.id == id);
            if !still_in_notes {
                if let Some(win) = app.get_webview_window(&format!("note-{}", id)) {
                    let _ = win.close();
                }
            }
            Err(e)
        }
    }
}

/// 付箋をゴミ箱へ移動する。`confirm_before_delete` が有効な場合は確認ダイアログを表示する。
#[tauri::command]
pub(crate) fn delete_note(
    id: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    if !confirm_delete_if_needed(&app, &state, &id) {
        return Ok(());
    }
    do_delete_note(&id, &app, &state)
}

/// ゴミ箱内の付箋一覧を返す。
#[tauri::command]
pub(crate) fn get_trash(state: State<AppState>) -> Vec<Note> {
    state.trash.recover().clone()
}

/// ゴミ箱の最大保存件数を返す。
#[tauri::command]
pub(crate) fn get_trash_max() -> usize {
    TRASH_MAX
}

/// ゴミ箱から付箋を notes へ戻す（メモリ上の移動＋保存のみ。ウィンドウは操作しない）。
/// 見つからない場合は `None`。
///
/// `delete_note_data` と対称に、移動後の notes / trash を計算してから保存し、
/// 1 本目 (notes.json) が成功してはじめてメモリへ反映する。1 本目が失敗した時点
/// ではメモリはまだ計算前のまま（ゴミ箱に残ったまま）なので、呼び出し元は無傷な
/// 状態で Err を受け取る。2 本目 (trash.json) の失敗はメモリを戻さない。
pub(crate) fn restore_note_data(state: &AppState, id: &str) -> Result<Option<Note>, String> {
    let (note, notes_snapshot, trash_snapshot) = {
        let trash = state.trash.recover();
        let Some(pos) = trash.iter().position(|n| n.id == id) else {
            return Ok(None);
        };
        let mut trash_snap = trash.clone();
        drop(trash);
        let mut note = trash_snap.remove(pos);
        note.deleted_at = None;
        let mut notes_snap = state.notes.recover().clone();
        // 保存が途中で止まって付箋とゴミ箱の両方に残った付箋を復元しても
        // 付箋側に同じ id が並ばないようにする。ゴミ箱のコピーは削除時点のもので
        // 以降の編集を含まないため、付箋側に残っているほうを勝たせる
        if !notes_snap.iter().any(|n| n.id == note.id) {
            notes_snap.push(note.clone());
        }
        (note, notes_snap, trash_snap)
    };
    // ゴミ箱側を先に消すと、間で中断したときにどちらのファイルからも消える。
    // この順なら両方に残るので復元し直せる
    save_notes(state, &notes_snapshot)?;
    // スナップショットで丸ごと差し替える。計算と反映の間に notes / trash を書く
    // 経路が並行して走ると更新が消えるため、コマンドのメインスレッド直列実行が前提
    *state.notes.recover() = notes_snapshot;
    *state.trash.recover() = trash_snapshot.clone();
    save_trash(state, &trash_snapshot)?;
    Ok(Some(note))
}

/// ゴミ箱から付箋を復元し、ウィンドウを開く。見つからない場合は `None`。
#[tauri::command]
pub(crate) fn restore_note(
    id: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<Option<Note>, String> {
    match restore_note_data(&state, &id) {
        Ok(note) => {
            if let Some(n) = &note {
                open_note_window(&app, n);
            }
            Ok(note)
        }
        Err(e) => {
            // ウィンドウを開くかは失敗した保存の本数ではなくメモリの状態で決める。
            // メモリの notes に付箋があれば（2 本目の保存失敗で反映済みの場合と、
            // 付箋側に同じ id が残っていた場合）ウィンドウを開く。出さないと
            // 付箋がどこにも見えなくなる。1 本目の失敗ではメモリも無傷で、
            // 付箋はまだゴミ箱に残っている
            let note = {
                let notes = state.notes.recover();
                notes.iter().find(|n| n.id == id).cloned()
            };
            if let Some(n) = &note {
                open_note_window(&app, n);
            }
            Err(e)
        }
    }
}

/// ゴミ箱を空にする（メモリ上の反映＋保存）。
///
/// 保存が成功してからメモリを clear する。先に clear すると、保存失敗時に
/// メモリだけ空になりディスクの trash.json には付箋が残ったままになる。
pub(crate) fn empty_trash_data(state: &AppState) -> Result<(), String> {
    let old_trash = state.trash.recover().clone();
    save_trash(state, &[])?;
    state.trash.recover().clear();
    // ゴミ箱ごと消えた付箋が参照していた画像を GC する
    let candidates: Vec<String> = old_trash
        .iter()
        .flat_map(|n| extract_image_paths(&n.content))
        .collect();
    if !candidates.is_empty() {
        let notes_snapshot = state.notes.recover().clone();
        gc_images(&state.data_dir, &candidates, &notes_snapshot, &[]);
    }
    Ok(())
}

/// ゴミ箱を空にする。
#[tauri::command]
pub(crate) fn empty_trash(state: State<AppState>) -> Result<(), String> {
    empty_trash_data(&state)
}

/// `get_settings` の戻り値。`Settings` に OS ロケールから解決した表示言語と、
/// 貼り付け画像の asset protocol URL 組み立てに使うデータディレクトリを添える。
/// いずれも `Settings` 本体には持たせない（`settings.json` への永続化を防ぐため）。
#[derive(serde::Serialize)]
pub(crate) struct SettingsResponse {
    #[serde(flatten)]
    settings: Settings,
    system_language: i18n::Lang,
    data_dir: String,
}

/// 現在の設定を返す。フロントエンドの `auto` 解決は OS ロケールを直接参照せず、
/// ここで返す `system_language`（Rust 側の解決結果）に一本化している。
#[tauri::command]
pub(crate) fn get_settings(state: State<AppState>) -> SettingsResponse {
    SettingsResponse {
        settings: state.settings.recover().clone(),
        system_language: i18n::system_language(),
        data_dir: state.data_dir.to_string_lossy().into_owned(),
    }
}

/// クリップボードから貼り付けられた画像を `images/<uuid v4>.png` として保存し、
/// content に埋め込む相対パスを返す。JS 側は `Uint8Array` を渡し、raw payload
/// (`InvokeBody::Raw`) として届く。
#[tauri::command]
pub(crate) fn save_pasted_image(
    request: Request<'_>,
    state: State<AppState>,
) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("save_pasted_image expects a raw byte payload".to_string());
    };
    persistence::save_pasted_image(&state.data_dir, bytes)
}

/// 設定を更新して保存する。数値は範囲内にクランプされる。
/// `language` が変わった場合は、アプリメニュー・トレイのメニュー・開いている設定/ゴミ箱
/// ウィンドウのタイトルを表示中の言語で組み直す。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri コマンドは個別引数が JS キーに対応するため
pub(crate) fn update_settings(
    default_color: String,
    opacity: u32,
    bring_all_to_front: bool,
    show_pin_button: bool,
    show_new_button: bool,
    show_color_button: bool,
    confirm_before_delete: bool,
    language: LanguageSetting,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    let (snapshot, language_changed) = {
        let mut settings = state.settings.recover();
        let language_changed = settings.language != language;
        if is_valid_default_color(&default_color) {
            settings.default_color = default_color;
        }
        settings.opacity = clamp_opacity(opacity);
        settings.bring_all_to_front = bring_all_to_front;
        settings.show_pin_button = show_pin_button;
        settings.show_new_button = show_new_button;
        settings.show_color_button = show_color_button;
        settings.confirm_before_delete = confirm_before_delete;
        settings.language = language;
        (settings.clone(), language_changed)
    };
    if language_changed {
        if let Err(e) = menu::rebuild_app_menu(&app) {
            log::error!("rebuild app menu error: {}", e);
        }
        if let Err(e) = tray::rebuild_tray(&app) {
            log::error!("rebuild tray error: {}", e);
        }
        // ネイティブウィンドウのタイトルは生成時にしか設定されないため、開いていれば組み直す
        let lang = i18n::resolve(snapshot.language);
        if let Some(win) = app.get_webview_window("settings") {
            let _ = win.set_title(i18n::text(lang, Msg::SettingsWindowTitle));
        }
        if let Some(win) = app.get_webview_window("trash") {
            let _ = win.set_title(i18n::text(lang, Msg::TrashWindowTitle));
        }
    }
    save_settings(&state, &snapshot)
}

/// 設定ウィンドウを開く（既に開いている場合はフォーカスを移す）。
#[tauri::command]
pub(crate) fn open_settings(app: AppHandle) {
    open_settings_window(&app, None);
}

/// ゴミ箱ウィンドウを開く（既に開いている場合はフォーカスを移す）。
#[tauri::command]
pub(crate) fn open_trash(app: AppHandle) {
    open_trash_window(&app);
}

/// 新しい付箋を作成してウィンドウを開き、作成した付箋を返す。
#[tauri::command]
pub(crate) fn create_note(app: AppHandle, state: State<AppState>) -> Note {
    create_note_with_window(&app, &state)
}

#[tauri::command]
pub(crate) fn show_context_menu(
    id: String,
    is_pinned: bool,
    current_color: String,
    image_path: Option<String>,
    has_selection: bool,
    app: AppHandle,
    state: State<AppState>,
) {
    let window_label = format!("note-{}", id);
    let Some(webview_win) = app.get_webview_window(&window_label) else {
        return;
    };

    // Store note ID so on_menu_event knows which note to target
    *state.context_menu_note_id.recover() = id;

    // フロント側の data 属性は DOM 改変で偽装され得るため、ここでも形状を検証してから保留する
    let validated_image_path = image_path.filter(|p| persistence::is_valid_image_rel_path(p));
    *state.context_menu_image_path.recover() = validated_image_path.clone();

    let lang = i18n::resolve(state.settings.recover().language);
    if let Err(e) = build_context_menu(
        &app,
        &webview_win,
        is_pinned,
        &current_color,
        validated_image_path.as_deref(),
        has_selection,
        lang,
    ) {
        log::error!("context menu error: {}", e);
    }
}

/// 画像削除の実処理。note の content の `line_idx` 行目にある `rel_path` の
/// `occurrence` 番目の画像記法だけを取り除いて保存する。note が見つからない・対象の
/// 1 箇所が content の現在値と噛み合わない（呼び出し元の状態が古い等）場合は `Ok(None)`。
/// 戻り値は保存後の content で、呼び出し元（`delete_image` コマンド）がフロントエンドの
/// `rawContent` をそのまま置き換えるのに使う。
///
/// 画像ファイルはここでは消さない。undo は JS 側ウィンドウローカルの履歴で、この
/// content 変更を取り消せば同じ画像参照が復活しうる。即時に GC すると、その復活の
/// 瞬間にファイルが既に無くて壊れた画像参照になる。孤児ファイルは起動時スイープ
/// （`persistence::sweep_orphaned_images`）でまとめて片付ける。
///
/// `delete_note_data` と同じく「ディスク確定 → メモリ反映」の順序を守る。先にメモリを
/// 書き換えてから保存すると、保存失敗時にメモリだけディスクより先に進んでしまう。
pub(crate) fn delete_image_data(
    state: &AppState,
    note_id: &str,
    rel_path: &str,
    line_idx: usize,
    occurrence: usize,
) -> Result<Option<String>, String> {
    let (new_content, notes_snapshot) = {
        let notes = state.notes.recover();
        let Some(note) = notes.iter().find(|n| n.id == note_id) else {
            log::warn!("delete_image: note not found: {}", note_id);
            return Ok(None);
        };
        let Some(new_content) =
            remove_image_occurrence_from_content(&note.content, rel_path, line_idx, occurrence)
        else {
            log::warn!(
                "delete_image: target does not match current content (note={}, line={}, occurrence={})",
                note_id,
                line_idx,
                occurrence
            );
            return Ok(None);
        };
        let mut snapshot = notes.clone();
        drop(notes);
        let pos = snapshot
            .iter()
            .position(|n| n.id == note_id)
            .expect("note found above still present in snapshot");
        snapshot[pos].content = new_content.clone();
        (new_content, snapshot)
    };
    save_notes(state, &notes_snapshot)?;
    *state.notes.recover() = notes_snapshot.clone();
    Ok(Some(new_content))
}

/// 画像を OS の既定アプリで開く。
#[tauri::command]
pub(crate) fn open_image(
    image_path: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    image_actions::open_image(&app, &state.data_dir, &image_path)
}

/// 選択中の画像を Backspace / Delete で削除する（右クリックメニューには削除項目を
/// 置かず、選択状態からのキー操作だけが入口）。`confirm_before_delete` が有効なら
/// 付箋削除と同じ確認ダイアログ基盤で確認し、キャンセルされたら `Ok(None)`。
/// 削除処理そのものは `delete_image_data` を使う。フロント側の data 属性は DOM 改変で
/// 偽装され得るため、`image_path` の形状はここでも検証する。
#[tauri::command]
pub(crate) fn delete_image(
    id: String,
    image_path: String,
    image_line: usize,
    image_occurrence: usize,
    app: AppHandle,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    if !persistence::is_valid_image_rel_path(&image_path) {
        return Ok(None);
    }
    if !confirm_delete_image_if_needed(&app, &state) {
        return Ok(None);
    }
    delete_image_data(&state, &id, &image_path, image_line, image_occurrence)
}

/// `run_on_main_thread` からの結果待ちが万一戻ってこなくても UI を無限にフリーズさせない
/// ための上限。画像コピーと Markdown コピー（テキスト）の両方で共有する。
const MAIN_THREAD_CLIPBOARD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// arboard 呼び出しをメインスレッドで実行し、結果を待ち合わせて返す。arboard は macOS で
/// NSPasteboard をメインスレッド外から操作するとクラッシュしうる
/// （`image_actions::copy_image_to_clipboard` の doc 参照）。この関数を呼ぶ `copy_image` /
/// `cut_image` は非 async コマンドで、Tauri の IPC はメッセージを受け取ったスレッド上で
/// そのままインライン実行する（別スレッドへディスパッチしない）。macOS ではその IPC 受信
/// 自体がメインスレッド（WKWebView のコールバック）で起きるため、コマンド本体はすでに
/// メインスレッド上で動いている。`run_on_main_thread` はメインスレッドから呼べば即時実行
/// されるため、ここでの委譲は安全に完結する。同メソッドはクロージャの戻り値を返さないため、
/// 結果は `std::sync::mpsc` で待ち合わせる（コマンドを async 化するとこのインライン実行の
/// 前提が崩れ、待ち合わせがイベントループの周回待ちになる点に注意）。
fn copy_image_on_main_thread(
    app: &AppHandle,
    data_dir: &Path,
    rel_path: &str,
) -> Result<(), String> {
    let data_dir = data_dir.to_path_buf();
    let rel_path = rel_path.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let result = image_actions::copy_image_to_clipboard(&data_dir, &rel_path);
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(MAIN_THREAD_CLIPBOARD_TIMEOUT)
        .map_err(|e| e.to_string())?
}

/// 選択中の画像をクリップボードにコピーする。`image_path` の形状・実在検証は
/// `copy_image_to_clipboard` が行う。
#[tauri::command]
pub(crate) fn copy_image(
    image_path: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    copy_image_on_main_thread(&app, &state.data_dir, &image_path)
}

/// arboard 呼び出しをメインスレッドで実行する（理由は `copy_image_on_main_thread` のコメント参照）。
fn copy_markdown_on_main_thread(app: &AppHandle, text: &str) -> Result<(), String> {
    let text = text.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let result = arboard::Clipboard::new()
            .and_then(|mut cb| cb.set_text(text))
            .map_err(|e| e.to_string());
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(MAIN_THREAD_CLIPBOARD_TIMEOUT)
        .map_err(|e| e.to_string())?
}

/// 選択範囲の生 Markdown をテキストとしてクリップボードにコピーする（右クリックメニューの
/// 「Markdown をコピー」）。text/html + text/plain を同時に載せる通常コピー（⌘C）とは別経路で、
/// こちらはプレーンテキスト 1 形式のみを載せる。
#[tauri::command]
pub(crate) fn copy_markdown(text: String, app: AppHandle) -> Result<(), String> {
    copy_markdown_on_main_thread(&app, &text)
}

/// `cut_image` の早期 return 条件（不正な画像パスなら実行せず `Ok(None)` として扱う）。
/// フロント側の data 属性は DOM 改変で偽装され得るため、コマンド側でも検証する。
/// `AppHandle` を要らない形に切り出しているのは、この判定単体をユニットテストするため。
fn cut_image_should_skip(image_path: &str) -> bool {
    !persistence::is_valid_image_rel_path(image_path)
}

/// カット（コピー → 削除）の削除側のロジック。`copy_result` は先に行ったコピーの成否
/// （`cut_image` では `copy_image_on_main_thread` の戻り値を渡す）。コピーに失敗していれば
/// 削除せずそのエラーを返す（消えて戻せない方が最悪なため、コピー成功が前提）。
/// `AppHandle` を要らない形に分けているのは、コピーの成否をここへ注入することでコピー→削除の
/// 順序をユニットテストできるようにするため（`copy_image_on_main_thread` 自体は
/// メインスレッド委譲が要るため単体テストできない）。
fn cut_image_after_copy(
    state: &AppState,
    note_id: &str,
    rel_path: &str,
    line_idx: usize,
    occurrence: usize,
    copy_result: Result<(), String>,
) -> Result<Option<String>, String> {
    copy_result?;
    delete_image_data(state, note_id, rel_path, line_idx, occurrence)
}

/// 選択中の画像を ⌘X でカットする（コピー → 削除）。macOS のカットの慣習に合わせて
/// 確認ダイアログは出さない（`delete_image` の `confirm_before_delete` 確認は経由しない。
/// クリップボードに載るためペーストで復元できる）。
#[tauri::command]
pub(crate) fn cut_image(
    id: String,
    image_path: String,
    image_line: usize,
    image_occurrence: usize,
    app: AppHandle,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    if cut_image_should_skip(&image_path) {
        return Ok(None);
    }
    let copy_result = copy_image_on_main_thread(&app, &state.data_dir, &image_path);
    cut_image_after_copy(
        &state,
        &id,
        &image_path,
        image_line,
        image_occurrence,
        copy_result,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Instant;
    use tempfile::TempDir;

    fn make_note(id: &str, content: &str) -> Note {
        Note {
            id: id.to_string(),
            content: content.to_string(),
            color: "yellow".to_string(),
            x: 0.0,
            y: 0.0,
            width: 280.0,
            height: 320.0,
            zoom: 100,
            pinned: false,
            deleted_at: None,
        }
    }

    /// notes / trash を初期値付きで構築するテスト用 `AppState`。保存先には `dir` を使う。
    fn make_state(dir: &TempDir, notes: Vec<Note>, trash: Vec<Note>) -> AppState {
        AppState {
            notes: Mutex::new(notes),
            settings: Mutex::new(Settings::default()),
            trash: Mutex::new(trash),
            last_bring_to_front: Mutex::new(Instant::now()),
            context_menu_note_id: Mutex::new(String::new()),
            context_menu_image_path: Mutex::new(None),
            data_dir: dir.path().to_path_buf(),
            notes_loaded: true,
            settings_loaded: true,
            trash_loaded: true,
            notes_load_error: None,
            settings_load_error: None,
            trash_load_error: None,
        }
    }

    fn read_notes_json(dir: &TempDir) -> Vec<Note> {
        let s = std::fs::read_to_string(dir.path().join("notes.json")).unwrap();
        serde_json::from_str(&s).unwrap()
    }

    fn read_trash_json(dir: &TempDir) -> Vec<Note> {
        let s = std::fs::read_to_string(dir.path().join("trash.json")).unwrap();
        serde_json::from_str(&s).unwrap()
    }

    /// テスト用の有効な uuid 形状パス（`persistence::is_valid_image_rel_path` の形状に一致）。
    fn uuid_image_path(n: u8) -> String {
        format!("images/00000000-0000-4000-8000-00000000000{}.png", n)
    }

    /// `dir/images/<filename>` にダミーの画像ファイルを置く。
    fn write_dummy_image(dir: &TempDir, image_path: &str) {
        let images_dir = dir.path().join("images");
        std::fs::create_dir_all(&images_dir).unwrap();
        std::fs::write(
            images_dir.join(image_path.strip_prefix("images/").unwrap()),
            b"data",
        )
        .unwrap();
    }

    fn image_exists(dir: &TempDir, image_path: &str) -> bool {
        dir.path()
            .join("images")
            .join(image_path.strip_prefix("images/").unwrap())
            .exists()
    }

    // ── SettingsResponse ──────────────────────────────────────

    #[test]
    fn settings_response_flattens_system_language_alongside_settings() {
        let response = SettingsResponse {
            settings: Settings::default(),
            system_language: i18n::Lang::Ja,
            data_dir: "/tmp/hattotto".to_string(),
        };

        let value = serde_json::to_value(&response).unwrap();

        assert_eq!(value["language"], serde_json::json!("auto"));
        assert_eq!(value["system_language"], serde_json::json!("ja"));
        assert_eq!(value["data_dir"], serde_json::json!("/tmp/hattotto"));
    }

    // ── delete_note_data ──────────────────────────────────────

    #[test]
    fn delete_note_data_moves_note_to_trash_and_persists() {
        let dir = TempDir::new().unwrap();
        let state = make_state(&dir, vec![make_note("a", "hello")], vec![]);

        let found = delete_note_data(&state, "a").unwrap();

        assert!(found);
        assert!(state.notes.recover().is_empty());
        assert_eq!(state.trash.recover().len(), 1);
        assert!(read_notes_json(&dir).is_empty());
        let trash_on_disk = read_trash_json(&dir);
        assert_eq!(trash_on_disk.len(), 1);
        assert_eq!(trash_on_disk[0].id, "a");
    }

    #[test]
    fn delete_note_data_sets_deleted_at() {
        let dir = TempDir::new().unwrap();
        let state = make_state(&dir, vec![make_note("a", "hello")], vec![]);

        delete_note_data(&state, "a").unwrap();

        assert!(state.trash.recover()[0].deleted_at.is_some());
    }

    #[test]
    fn delete_note_data_replaces_existing_trash_entry_with_same_id() {
        let dir = TempDir::new().unwrap();
        let mut stale = make_note("a", "stale");
        stale.deleted_at = Some(1);
        let state = make_state(&dir, vec![make_note("a", "fresh")], vec![stale]);

        delete_note_data(&state, "a").unwrap();

        let trash = state.trash.recover();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].content, "fresh");
    }

    #[test]
    fn delete_note_data_enforces_trash_limit() {
        let dir = TempDir::new().unwrap();
        let existing_trash: Vec<Note> = (0..TRASH_MAX)
            .map(|i| make_note(&i.to_string(), ""))
            .collect();
        let state = make_state(&dir, vec![make_note("new", "hello")], existing_trash);

        delete_note_data(&state, "new").unwrap();

        let trash = state.trash.recover();
        assert_eq!(trash.len(), TRASH_MAX);
        assert_eq!(trash[0].id, "1"); // oldest ("0") dropped
        assert_eq!(trash.last().unwrap().id, "new");
    }

    /// FIFO で完全にゴミ箱から溢れた付箋（＝もうどこにも残らない）が参照していた画像は消える。
    #[test]
    fn delete_note_data_fifo_overflow_gc_removes_drained_notes_image() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(1);
        write_dummy_image(&dir, &image_path);

        let mut existing_trash: Vec<Note> = (0..TRASH_MAX)
            .map(|i| make_note(&i.to_string(), ""))
            .collect();
        existing_trash[0].content = format!("![]({})", image_path); // oldest → FIFO で drop される
        let state = make_state(&dir, vec![make_note("new", "hello")], existing_trash);

        delete_note_data(&state, "new").unwrap();

        assert!(!image_exists(&dir, &image_path));
    }

    /// drop された付箋の画像でも、残っている別の付箋がまだ参照していれば消さない。
    #[test]
    fn delete_note_data_fifo_overflow_gc_keeps_image_referenced_by_remaining_note() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(2);
        write_dummy_image(&dir, &image_path);

        let mut existing_trash: Vec<Note> = (0..TRASH_MAX)
            .map(|i| make_note(&i.to_string(), ""))
            .collect();
        existing_trash[0].content = format!("![]({})", image_path); // drop される
        existing_trash[1].content = format!("![]({})", image_path); // drop されずに残る
        let state = make_state(&dir, vec![make_note("new", "hello")], existing_trash);

        delete_note_data(&state, "new").unwrap();

        assert!(image_exists(&dir, &image_path));
    }

    #[test]
    fn delete_note_data_nonexistent_id_returns_false_and_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let state = make_state(&dir, vec![make_note("a", "")], vec![]);

        let found = delete_note_data(&state, "missing").unwrap();

        assert!(!found);
        assert!(!dir.path().join("notes.json").exists());
        assert!(!dir.path().join("trash.json").exists());
    }

    // ── delete_note_data: 空の付箋（issue #56） ──────────────────

    #[test]
    fn delete_note_data_empty_note_skips_trash() {
        let dir = TempDir::new().unwrap();
        let state = make_state(&dir, vec![make_note("a", "")], vec![make_note("z", "kept")]);

        let found = delete_note_data(&state, "a").unwrap();

        assert!(found);
        assert!(state.notes.recover().is_empty());
        let trash = state.trash.recover();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, "z");
        assert!(read_notes_json(&dir).is_empty());
        assert!(!dir.path().join("trash.json").exists());
    }

    #[test]
    fn delete_note_data_whitespace_only_note_skips_trash() {
        let dir = TempDir::new().unwrap();
        let state = make_state(&dir, vec![make_note("a", "  \n\t\n  ")], vec![]);

        delete_note_data(&state, "a").unwrap();

        assert!(state.notes.recover().is_empty());
        assert!(state.trash.recover().is_empty());
        assert!(!dir.path().join("trash.json").exists());
    }

    /// 保存の中断で同じ id がゴミ箱にも残っていた空の付箋を削除すると、残骸も掃除される。
    #[test]
    fn delete_note_data_empty_note_cleans_stale_trash_entry() {
        let dir = TempDir::new().unwrap();
        let mut stale = make_note("a", "stale");
        stale.deleted_at = Some(1);
        let state = make_state(
            &dir,
            vec![make_note("a", "")],
            vec![stale, make_note("z", "kept")],
        );

        delete_note_data(&state, "a").unwrap();

        assert!(state.notes.recover().is_empty());
        let trash_ids: Vec<String> = state.trash.recover().iter().map(|n| n.id.clone()).collect();
        assert_eq!(trash_ids, vec!["z"]);
        let disk = read_trash_json(&dir);
        assert_eq!(disk.len(), 1);
        assert_eq!(disk[0].id, "z");
    }

    /// 空の付箋の削除で notes.json の保存が失敗しても、メモリは無傷のまま。
    #[test]
    fn delete_note_data_empty_note_save_failure_leaves_memory_untouched() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("notes.json")).unwrap();
        let state = make_state(&dir, vec![make_note("a", "")], vec![]);

        assert!(delete_note_data(&state, "a").is_err());

        assert_eq!(state.notes.recover().len(), 1);
        assert_eq!(state.notes.recover()[0].id, "a");
        assert!(state.trash.recover().is_empty());
    }

    /// ゴミ箱側を先に書く順序の確認。notes.json への書き込みをディレクトリ衝突で
    /// 失敗させても、trash.json には既に書けているので捨て直せる状態が残る。
    #[test]
    fn delete_note_data_writes_trash_before_notes() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("notes.json")).unwrap();
        let state = make_state(&dir, vec![make_note("a", "hello")], vec![]);

        assert!(delete_note_data(&state, "a").is_err());

        assert_eq!(read_trash_json(&dir)[0].id, "a");
    }

    /// 1 本目 (trash.json) の保存が失敗したとき、メモリはまだ計算前のまま
    /// （notes に残り trash には入らない）で、notes.json も書かれない。
    #[test]
    fn delete_note_data_first_save_failure_leaves_memory_untouched() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("trash.json")).unwrap();
        let state = make_state(&dir, vec![make_note("a", "hello")], vec![]);

        assert!(delete_note_data(&state, "a").is_err());

        assert_eq!(state.notes.recover().len(), 1);
        assert_eq!(state.notes.recover()[0].id, "a");
        assert!(state.trash.recover().is_empty());
        assert!(!dir.path().join("notes.json").exists());
    }

    /// 2 本目 (notes.json) の保存が失敗しても、メモリは新しい状態（notes から消え
    /// trash に入る）へ反映済みで、1 本目に成功した trash.json にも書かれている。
    #[test]
    fn delete_note_data_second_save_failure_still_updates_memory() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("notes.json")).unwrap();
        let state = make_state(&dir, vec![make_note("a", "hello")], vec![]);

        assert!(delete_note_data(&state, "a").is_err());

        assert!(state.notes.recover().is_empty());
        assert_eq!(state.trash.recover().len(), 1);
        assert_eq!(state.trash.recover()[0].id, "a");
        assert_eq!(read_trash_json(&dir)[0].id, "a");
    }

    // ── restore_note_data ─────────────────────────────────────

    #[test]
    fn restore_note_data_moves_note_to_notes_and_persists() {
        let dir = TempDir::new().unwrap();
        let mut trashed = make_note("a", "hello");
        trashed.deleted_at = Some(123);
        let state = make_state(&dir, vec![], vec![trashed]);

        let restored = restore_note_data(&state, "a").unwrap();

        assert_eq!(restored.unwrap().deleted_at, None);
        assert!(state.trash.recover().is_empty());
        assert_eq!(state.notes.recover().len(), 1);
        let notes_on_disk = read_notes_json(&dir);
        assert_eq!(notes_on_disk.len(), 1);
        assert_eq!(notes_on_disk[0].id, "a");
        assert!(read_trash_json(&dir).is_empty());
    }

    #[test]
    fn restore_note_data_keeps_existing_notes_entry_on_duplicate_id() {
        let dir = TempDir::new().unwrap();
        let mut trashed = make_note("a", "stale-from-trash");
        trashed.deleted_at = Some(1);
        let state = make_state(&dir, vec![make_note("a", "fresh-in-notes")], vec![trashed]);

        restore_note_data(&state, "a").unwrap();

        let notes = state.notes.recover();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].content, "fresh-in-notes");
    }

    #[test]
    fn restore_note_data_nonexistent_id_returns_none_and_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let state = make_state(&dir, vec![], vec![make_note("a", "")]);

        let restored = restore_note_data(&state, "missing").unwrap();

        assert!(restored.is_none());
        assert!(!dir.path().join("notes.json").exists());
        assert!(!dir.path().join("trash.json").exists());
    }

    /// 付箋側を先に書く順序の確認。trash.json への書き込みをディレクトリ衝突で
    /// 失敗させても、notes.json には既に書けているので復元し直せる状態が残る。
    #[test]
    fn restore_note_data_writes_notes_before_trash() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("trash.json")).unwrap();
        let state = make_state(&dir, vec![], vec![make_note("a", "hello")]);

        assert!(restore_note_data(&state, "a").is_err());

        assert_eq!(read_notes_json(&dir)[0].id, "a");
    }

    /// 1 本目 (notes.json) の保存が失敗したとき、メモリはまだ計算前のまま
    /// （trash に残り notes には入らない）で、trash.json も書かれない。
    #[test]
    fn restore_note_data_first_save_failure_leaves_memory_untouched() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("notes.json")).unwrap();
        let state = make_state(&dir, vec![], vec![make_note("a", "hello")]);

        assert!(restore_note_data(&state, "a").is_err());

        assert!(state.notes.recover().is_empty());
        assert_eq!(state.trash.recover().len(), 1);
        assert_eq!(state.trash.recover()[0].id, "a");
        assert!(!dir.path().join("trash.json").exists());
    }

    /// 2 本目 (trash.json) の保存が失敗しても、メモリは新しい状態（trash から消え
    /// notes に入る）へ反映済みで、1 本目に成功した notes.json にも書かれている。
    #[test]
    fn restore_note_data_second_save_failure_still_updates_memory() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("trash.json")).unwrap();
        let state = make_state(&dir, vec![], vec![make_note("a", "hello")]);

        assert!(restore_note_data(&state, "a").is_err());

        assert_eq!(state.notes.recover().len(), 1);
        assert_eq!(state.notes.recover()[0].id, "a");
        assert!(state.trash.recover().is_empty());
        assert_eq!(read_notes_json(&dir)[0].id, "a");
    }

    // ── empty_trash_data ──────────────────────────────────────

    /// 保存が失敗したときはメモリの trash を clear しない。
    #[test]
    fn empty_trash_data_save_failure_leaves_memory_untouched() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("trash.json")).unwrap();
        let state = make_state(&dir, vec![], vec![make_note("a", "hello")]);

        assert!(empty_trash_data(&state).is_err());

        assert_eq!(state.trash.recover().len(), 1);
    }

    #[test]
    fn empty_trash_data_clears_memory_and_persists() {
        let dir = TempDir::new().unwrap();
        let state = make_state(&dir, vec![], vec![make_note("a", "hello")]);

        empty_trash_data(&state).unwrap();

        assert!(state.trash.recover().is_empty());
        assert!(read_trash_json(&dir).is_empty());
    }

    /// ゴミ箱ごと消えた付箋が参照していた画像は GC される。
    #[test]
    fn empty_trash_data_gc_removes_unreferenced_image() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(3);
        write_dummy_image(&dir, &image_path);
        let trash = vec![make_note("t", &format!("![]({})", image_path))];
        let state = make_state(&dir, vec![], trash);

        empty_trash_data(&state).unwrap();

        assert!(!image_exists(&dir, &image_path));
    }

    /// notes 側にまだ参照が残っていれば、ゴミ箱を空にしても画像は消さない。
    #[test]
    fn empty_trash_data_gc_keeps_image_still_referenced_by_notes() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(4);
        write_dummy_image(&dir, &image_path);
        let notes = vec![make_note("n", &format!("![]({})", image_path))];
        let trash = vec![make_note("t", &format!("![]({})", image_path))];
        let state = make_state(&dir, notes, trash);

        empty_trash_data(&state).unwrap();

        assert!(image_exists(&dir, &image_path));
    }

    // ── delete_image_data ─────────────────────────────────────

    #[test]
    fn delete_image_data_removes_image_only_line_and_persists() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(1);
        write_dummy_image(&dir, &image_path);
        let content = format!("見出し\n![]({})\n本文", image_path);
        let state = make_state(&dir, vec![make_note("a", &content)], vec![]);

        let result = delete_image_data(&state, "a", &image_path, 1, 0).unwrap();

        assert_eq!(result, Some("見出し\n本文".to_string()));
        assert_eq!(state.notes.recover()[0].content, "見出し\n本文");
        assert_eq!(read_notes_json(&dir)[0].content, "見出し\n本文");
    }

    /// 画像削除は content から参照を消すだけで、ファイル自体は残す。undo で参照が
    /// 復活しても壊れた画像にならないようにするための挙動。孤児化したファイルは
    /// 起動時スイープ（`persistence::sweep_orphaned_images`）が片付ける。
    #[test]
    fn delete_image_data_keeps_file_after_last_reference_removed() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(2);
        write_dummy_image(&dir, &image_path);
        let content = format!("![]({})", image_path);
        let state = make_state(&dir, vec![make_note("a", &content)], vec![]);

        delete_image_data(&state, "a", &image_path, 0, 0).unwrap();

        assert!(image_exists(&dir, &image_path));
    }

    /// 他の付箋がまだ同じ画像を参照していれば、そちらは触らずファイルも消さない。
    #[test]
    fn delete_image_data_keeps_image_still_referenced_by_another_note() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(3);
        write_dummy_image(&dir, &image_path);
        let content_a = format!("![]({})", image_path);
        let content_b = format!("別の付箋 ![]({})", image_path);
        let state = make_state(
            &dir,
            vec![make_note("a", &content_a), make_note("b", &content_b)],
            vec![],
        );

        let result = delete_image_data(&state, "a", &image_path, 0, 0).unwrap();

        assert_eq!(result, Some(String::new()));
        let notes = state.notes.recover();
        assert_eq!(
            notes.iter().find(|n| n.id == "b").unwrap().content,
            content_b
        );
        assert!(image_exists(&dir, &image_path));
    }

    #[test]
    fn delete_image_data_strips_syntax_only_from_mixed_line() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(4);
        write_dummy_image(&dir, &image_path);
        let content = format!("テキスト ![]({}) 続き", image_path);
        let state = make_state(&dir, vec![make_note("a", &content)], vec![]);

        let result = delete_image_data(&state, "a", &image_path, 0, 0).unwrap();

        assert_eq!(result, Some("テキスト  続き".to_string()));
    }

    /// クリックされた 1 箇所だけを取り除く。同じ画像を参照する他の行は無傷のまま残り、
    /// その参照が残っている限り画像ファイルも GC されない。
    #[test]
    fn delete_image_data_only_removes_targeted_occurrence_and_keeps_other_lines() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(8);
        write_dummy_image(&dir, &image_path);
        let content = format!(
            "![]({})\nテキスト ![別alt]({}) 続き",
            image_path, image_path
        );
        let state = make_state(&dir, vec![make_note("a", &content)], vec![]);

        let result = delete_image_data(&state, "a", &image_path, 0, 0).unwrap();

        let expected = format!("テキスト ![別alt]({}) 続き", image_path);
        assert_eq!(result, Some(expected.clone()));
        assert_eq!(state.notes.recover()[0].content, expected);
        // 2 行目にまだ参照が残っているので画像ファイルは消えない
        assert!(image_exists(&dir, &image_path));
    }

    #[test]
    fn delete_image_data_unknown_note_returns_none() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(5);
        let state = make_state(&dir, vec![], vec![]);

        let result = delete_image_data(&state, "missing", &image_path, 0, 0).unwrap();

        assert_eq!(result, None);
    }

    #[test]
    fn delete_image_data_no_matching_reference_returns_none_and_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let (present, absent) = (uuid_image_path(6), uuid_image_path(7));
        let content = format!("![]({})", present);
        let state = make_state(&dir, vec![make_note("a", &content)], vec![]);

        let result = delete_image_data(&state, "a", &absent, 0, 0).unwrap();

        assert_eq!(result, None);
        assert_eq!(state.notes.recover()[0].content, content);
        assert!(!dir.path().join("notes.json").exists());
    }

    /// occurrence が実在しない（フロントの状態が content の現在値とずれていた等）場合も
    /// 何も変えずに None を返す。
    #[test]
    fn delete_image_data_stale_occurrence_returns_none_and_writes_nothing() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(9);
        let content = format!("![]({})", image_path);
        let state = make_state(&dir, vec![make_note("a", &content)], vec![]);

        let result = delete_image_data(&state, "a", &image_path, 0, 1).unwrap();

        assert_eq!(result, None);
        assert_eq!(state.notes.recover()[0].content, content);
        assert!(!dir.path().join("notes.json").exists());
    }

    /// 保存が失敗したときはメモリを書き換えない（`delete_note_data` と同じ
    /// 「ディスク確定 → メモリ反映」の順序であることの確認）。
    #[test]
    fn delete_image_data_save_failure_leaves_memory_untouched() {
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join("notes.json")).unwrap();
        let image_path = uuid_image_path(10);
        let content = format!("![]({})", image_path);
        let state = make_state(&dir, vec![make_note("a", &content)], vec![]);

        let result = delete_image_data(&state, "a", &image_path, 0, 0);

        assert!(result.is_err());
        assert_eq!(state.notes.recover()[0].content, content);
    }

    // ── cut_image_after_copy ───────────────────────────────────
    // コピー処理はメインスレッド委譲が要るため単体テストできない。その戻り値を模した
    // Result<(), String> を直接注入して「コピー成功→削除」「コピー失敗→削除しない」の
    // 順序だけを検証する。

    #[test]
    fn cut_image_after_copy_deletes_when_copy_succeeds() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(11);
        write_dummy_image(&dir, &image_path);
        let content = format!("見出し\n![]({})\n本文", image_path);
        let state = make_state(&dir, vec![make_note("a", &content)], vec![]);

        let result = cut_image_after_copy(&state, "a", &image_path, 1, 0, Ok(()));

        assert_eq!(result, Ok(Some("見出し\n本文".to_string())));
        assert_eq!(state.notes.recover()[0].content, "見出し\n本文");
    }

    /// コピーに失敗した場合は削除処理そのものを呼ばない（消えて戻せない方が最悪なため）。
    #[test]
    fn cut_image_after_copy_does_not_delete_when_copy_fails() {
        let dir = TempDir::new().unwrap();
        let image_path = uuid_image_path(12);
        write_dummy_image(&dir, &image_path);
        let content = format!("![]({})", image_path);
        let state = make_state(&dir, vec![make_note("a", &content)], vec![]);

        let result = cut_image_after_copy(
            &state,
            "a",
            &image_path,
            0,
            0,
            Err("clipboard error".to_string()),
        );

        assert_eq!(result, Err("clipboard error".to_string()));
        assert_eq!(state.notes.recover()[0].content, content);
        assert!(image_exists(&dir, &image_path));
    }

    // ── cut_image_should_skip ────────────────────────────────

    #[test]
    fn cut_image_should_skip_rejects_invalid_path() {
        assert!(cut_image_should_skip("images/../notes.json"));
        assert!(cut_image_should_skip("not-an-image-path"));
    }

    #[test]
    fn cut_image_should_skip_accepts_valid_path() {
        assert!(!cut_image_should_skip(&uuid_image_path(3)));
    }

    // ── delete → restore round-trip ───────────────────────────

    #[test]
    fn delete_then_restore_returns_note_to_notes() {
        let dir = TempDir::new().unwrap();
        let state = make_state(&dir, vec![make_note("a", "hello")], vec![]);

        delete_note_data(&state, "a").unwrap();
        let restored = restore_note_data(&state, "a").unwrap().unwrap();

        assert_eq!(restored.content, "hello");
        assert_eq!(restored.deleted_at, None);
        assert!(read_trash_json(&dir).is_empty());
        assert_eq!(read_notes_json(&dir)[0].id, "a");
    }
}
