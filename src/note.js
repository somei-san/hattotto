// ── Globals ───────────────────────────────────────
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWebviewWindow } = window.__TAURI__.webviewWindow;
const appWindow = getCurrentWebviewWindow();

const params = new URLSearchParams(window.location.search);
const noteId = params.get('id');

const noteEl    = document.getElementById('note');
const titlebar  = document.getElementById('titlebar');
const picker    = document.getElementById('color-picker');
const mdView    = document.getElementById('markdown-view');
const pinBtn    = document.getElementById('btn-pin');
const newBtn    = document.getElementById('btn-new');
const colorBtn  = document.getElementById('btn-color');

/** File を含むドラッグかどうか。dragover 時点でも `types` は（protected mode でも）参照できる。 */
function isFileDrag(e) {
  return e.dataTransfer.types.includes('Files');
}

// Tauri の drag-drop ハンドラは付箋ウィンドウだけ無効化している（src-tauri/src/window.rs）ため、
// ファイルドラッグは HTML5 API に委ねられる。preventDefault が無いと WKWebView がドロップされた
// ファイルを file:// として開いてしまう。ファイル以外のドラッグ（テキスト選択など）の既定動作は
// 奪わないよう、File を含むドラッグだけを止める。挿入処理の本体は別の場所にある
document.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => { if (isFileDrag(e)) e.preventDefault(); });

let saveTimer = null;

// ── Editor State ──────────────────────────────────
// rawContent が唯一の真実。#markdown-view は contenteditable で、beforeinput を全てフックして
// splice → 再描画に変換するため、rawContent は毎打鍵ごとに最新（デバウンスされるのは Rust 側への
// 保存だけ）。DOM を編集結果の真実として読むことはない。
let rawContent = '';
let composing = false;
// IME 変換開始時点のキャレット/選択位置（{start, end} の raw bounds）。compositionend で
// この位置へ確定文字列を splice する（詳細は compositionend リスナー参照）
let compositionBounds = null;
// compositionend 直後の 1 マイクロタスクぶんだけ true になる（詳細は compositionend
// リスナー付近の markPostCompositionSuppression 参照）
let suppressPostCompositionInput = false;

// インライン生表示（reveal）。キャレットが装飾（太字/斜字/取り消し線/インラインコード/リンク）の
// 中・境界にあるあいだ、その要素だけ生マーカー付きで表示する状態。表示だけの状態で
// rawContent・undo には影響しない（詳細は selectionchange リスナー付近参照）。
// { line, start, end } | null。start/end は line のマーカーを除いた内容上の raw オフセット
let revealState = null;

// ⌘Z/⌘⇧Z の undo/redo 履歴。loadNote() が最初の content で初期化する
let editHistory = null;

// `save_pasted_image`（Rust 側）が生成するパスの形状（`images/<uuid v4>.<ext>`）とだけ一致させる。
// asset protocol の scope（$APPDATA/images/**/*）を信じきらず、`images/../notes.json` のような
// 細工パスを resolveImageSrc で asset URL に変換してしまわないための最終防衛ライン。
const IMAGE_REL_PATH_RE = /^images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)$/i;
function isValidImageRelPath(path) {
  return typeof path === 'string' && IMAGE_REL_PATH_RE.test(path);
}

/** 失敗を握り潰してよい操作向けの invoke。エラーはログとトーストに出す。 */
function fireInvoke(cmd, args, failMessage) {
  return invoke(cmd, args).catch(e => {
    console.error(`${cmd} failed:`, e);
    showToast(failMessage);
  });
}

// ── Apply Settings to UI ─────────────────────────
function applySettings(s) {
  noteEl.style.opacity = (s.opacity ?? 100) / 100;
  pinBtn.style.display = s.show_pin_button === false ? 'none' : '';
  newBtn.style.display = s.show_new_button === false ? 'none' : '';
  colorBtn.style.display = s.show_color_button === false ? 'none' : '';
}

// ── Toggle Pin State ────────────────────────────
function applyPinState(isPinned) {
  pinBtn.classList.toggle('active', isPinned);
  pinBtn.setAttribute('aria-pressed', String(isPinned));
  const label = I18N.t(isPinned ? 'unpinButton' : 'pinButton');
  pinBtn.title = label;
  pinBtn.setAttribute('aria-label', label);
}

async function togglePin() {
  const isPinned = !pinBtn.classList.contains('active');
  applyPinState(isPinned);
  try {
    await appWindow.setAlwaysOnTop(isPinned);
    await invoke('update_note_pinned', { id: noteId, pinned: isPinned });
  } catch (e) {
    console.error('togglePin failed:', e);
    applyPinState(!isPinned); // 失敗時はUI を元に戻す
  }
}

// ── Apply Color Theme ─────────────────────────────
let currentColor = 'yellow';

const VALID_COLORS = ['yellow','blue','green','pink','purple','gray'];

function applyColor(color) {
  if (!VALID_COLORS.includes(color)) color = 'yellow';
  currentColor = color;
  noteEl.style.setProperty('--bg',  `var(--${color})`);
  noteEl.style.setProperty('--bar', `var(--${color}-bar)`);

  document.querySelectorAll('.color-dot').forEach(d => {
    const selected = d.dataset.color === color;
    d.classList.toggle('active', selected);
    d.setAttribute('aria-checked', String(selected));
    d.setAttribute('tabindex', selected ? '0' : '-1');
  });
}

// ── Load Note Data ────────────────────────────────
async function loadNote() {
  let note, settings;
  try {
    [note, settings] = await Promise.all([
      invoke('get_note', { id: noteId }),
      invoke('get_settings'),
    ]);
  } catch (e) {
    console.error('loadNote failed:', e);
    return;
  }
  if (!note) {
    console.error('Note not found, closing window:', noteId);
    appWindow.close();
    return;
  }

  I18N.setLang(I18N.resolve(settings?.language, settings?.system_language));

  // 貼り付け画像の asset protocol URL 組み立て。data_dir は起動のたびに変わらないので一度だけ設定する
  if (settings?.data_dir) {
    const { convertFileSrc } = window.__TAURI__.core;
    // 形状が一致しないパスは asset URL に変換せずそのまま返す（存在しないファイルとして扱われるだけで済む）
    window.resolveImageSrc = (relPath) => isValidImageRelPath(relPath)
      ? convertFileSrc(`${settings.data_dir}/${relPath}`)
      : relPath;
  }

  rawContent = note.content;
  editHistory = createHistory(rawContent);
  renderAll();
  applyColor(note.color);

  if (settings) {
    applySettings(settings);
  }
  // Apply pinned state
  applyPinState(!!note.pinned);
  if (note.pinned) {
    appWindow.setAlwaysOnTop(true);
  }
  // Apply per-note zoom
  currentZoom = note.zoom ?? 100;
  applyZoom(currentZoom);
}

// ── Render ─────────────────────────────────────────
const getLines = () => rawContent.split('\n');

function renderAll() {
  // 描画済み DOM を丸ごと差し替えるため、直前まで指していた画像の参照ごとハンドルを消す
  // （放置すると detached な img へ書き込む・別画像の上にハンドルが残る事故になる）
  hideHandle();
  mdView.innerHTML = renderMarkdown(rawContent, revealState);
  markNonEditableElements();
  applySelectionHighlight();
}

/** キャレット・タイピングの対象から外す要素。img はネイティブ編集で書き換わると data-rel-src
 * との対応が壊れる。チェックボックスの input は change ハンドラで扱う。.md-order-num は表示専用の
 * 自動採番（raw に対応する文字が無い）で、キャレットがその内部へ落ちて余計な raw 位置に
 * 文字が入るのを防ぐ。 */
function markNonEditableElements() {
  mdView.querySelectorAll('img, input[type="checkbox"], .md-order-num').forEach((el) => {
    el.contentEditable = 'false';
  });
}

/** 行 lineIdx を含む描画済みブロックを返す。フェンスは複数行を 1 ブロックとして持つ。 */
function findBlock(lineIdx) {
  for (const el of mdView.children) {
    if (el.dataset.line == null) continue;
    const start = Number(el.dataset.line);
    const end = el.dataset.lineEnd != null ? Number(el.dataset.lineEnd) : start;
    if (lineIdx >= start && lineIdx <= end) return { el, start, end };
  }
  return null;
}

/** el 内の文字オフセットを (テキストノード, ノード内オフセット) に解決する。 */
function nodeAt(el, offset) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = offset, node, last = null;
  while ((node = walker.nextNode())) {
    last = node;
    if (remaining <= node.textContent.length) return { node, offset: remaining };
    remaining -= node.textContent.length;
  }
  return last ? { node: last, offset: last.textContent.length } : null;
}

// ── Image Selection ───────────────────────────────
// 画像のみの行（前後空白のみの `![alt|width](images/...)`）はキャレットを持たず、代わりに
// 「選択状態」を持つ（placeCaretAtRaw が唯一の入口）。選択は 1 画像のみ（複数選択なし）で、
// { line, occurrence, relSrc } を保持する。line/occurrence は Rust 側の画像削除
// （`delete_image` コマンド）が対象を 1 箇所だけに絞るのと同じ単位（rewriteImageWidth /
// imageOccurrenceInLine と同じ考え方）。
let selectedImage = null;

// contextmenu ハンドラで「Markdown をコピー」用に計算し退避しておく生 Markdown 文字列。
// メニュー表示前に flushContent() が挟まると DOM 選択（Range）が renderAll() で失われるため、
// 退避はメニューを開く invoke の直前・DOM がまだ壊れていない時点で行う（詳細は contextmenu
// リスナー側のコメント参照）。選択が無ければ null。
let pendingMarkdownCopy = null;

/** 選択を解除し、ハイライト用クラスと DOM 選択（Range）も剥がす。 */
function clearImageSelection() {
  if (!selectedImage) return;
  selectedImage = null;
  // querySelectorAll で念のため複数剥がす（1 画像のみの不変条件を守る側の防御）
  mdView.querySelectorAll('.img-selected').forEach(el => el.classList.remove('img-selected'));
  // 画像に張った DOM 選択も一緒に外す（張ったままだと次に別行へキャレットを置くときに
  // 「範囲選択中はキャレットを置かない」ガードへ誤って引っかかる）
  const sel = window.getSelection();
  if (sel.rangeCount) sel.removeAllRanges();
}

/**
 * img 要素を DOM 選択（Range）で覆う。ネイティブの Edit メニュー（PredefinedMenuItem::copy/cut）
 * は「テキスト選択が無いと項目自体が無効」になり keydown も届かないため、⌘C/⌘X をメニュー経由で
 * 機能させるには DOM 選択を張って項目を有効化しておく必要がある。実際のコピー/カット処理は
 * document の copy/cut イベント（copySelectedImage 等）で拾う。
 */
function selectImageRange(img) {
  const range = document.createRange();
  range.selectNode(img);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * selectedImage が指す img 要素に選択枠（.img-selected）と DOM 選択を付け直す。renderAll() の
 * 直後（mdView.innerHTML を丸ごと差し替えた直後）に呼び、選択状態を新しい DOM へ引き継ぐ。
 * 対象がもう存在しない（行が消えた・画像が無くなった等）場合は選択そのものを解除する。
 */
function applySelectionHighlight() {
  if (!selectedImage) return;
  const lineEl = mdView.querySelector(`[data-line="${selectedImage.line}"]`);
  if (!lineEl) { selectedImage = null; return; }
  const imgs = Array.from(lineEl.querySelectorAll('img[data-rel-src]'))
    .filter(el => el.dataset.relSrc === selectedImage.relSrc);
  const img = imgs[selectedImage.occurrence];
  if (!img) { selectedImage = null; return; }
  img.classList.add('img-selected');
  selectImageRange(img);
  // キー操作（←/→/↑/↓）で画面外の画像行へ着地したとき、選択枠が唯一の状態表示なので
  // 見える位置までスクロールする
  img.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

/** 行テキスト中で最初に出てくる画像記法の src を取り出す。無ければ null。 */
function firstImageRelSrc(lineText) {
  const m = lineText.match(/!\[[^\]]*\]\(([^)\s]+)\)/);
  return m ? m[1] : null;
}

/**
 * 行 line の occurrence 番目（relSrc と一致する画像のうち何番目か。imageOccurrenceInLine と
 * 同じ定義）の画像を選択状態にする。relSrc は呼び出し元が特定して渡す（行テキストを
 * 記法の出現順に数え直すと、混在する別画像の occurrence 定義とずれるため、ここでは数え直さない）。
 */
function selectImage(line, occurrence, relSrc) {
  // 選択は 1 画像のみ。次の選択を立てる前に必ず前の選択を解除する
  // （↑↓ で画像のみの行から画像のみの行へ直接移る経路は placeCaretAtRaw の
  // 「非画像なら clearImageSelection」を通らないため、ここで解除しないと 2 つ同時に残る）
  clearImageSelection();
  if (!relSrc || !isValidImageRelPath(relSrc)) return;
  selectedImage = { line, occurrence, relSrc };
  applySelectionHighlight();
}

// ── Caret Placement ────────────────────────────────
// 描画 DOM（#markdown-view）自体が contenteditable なので、キャレットは常にネイティブの
// DOM 位置として存在する。行の生 Markdown 位置からキャレットを置く必要があるのは、クリックで
// 特定の行へ飛ぶ場合ではなく（それはネイティブ配置に任せる）、行・列が既に分かっている
// プログラム的な移動（splice 系の編集後の再配置・undo/redo・画像削除後の着地・画像選択の
// キーボード移動等）のときだけ。

/** 行 line の raw 列 col（null なら行末）へキャレットを置く。画像のみの行は選択状態にする
 * （キャレット配置全体の唯一の関所）。 */
function placeCaretAtRaw(line, col) {
  const lines = getLines();
  const i = Math.max(0, Math.min(line, lines.length - 1));
  const block = findBlock(i);
  // 未終端フェンスの中では行の見た目が画像のみでも実際には画像として描画されない
  // （<pre> の中の生テキスト）ため、単独ブロック（フェンスでない）のときだけ対象にする
  const isStandalone = !block || block.start === block.end;
  if (isStandalone && isImageOnlyLine(lines[i] ?? '')) {
    selectImage(i, 0, firstImageRelSrc(lines[i]));
    return;
  }
  clearImageSelection();
  const lineText = lines[i] ?? '';
  const targetCol = col == null ? lineText.length : Math.min(Math.max(col, 0), lineText.length);
  setCaretAtRaw(i, targetCol);
}

/**
 * (line, col) の raw 位置へ実際に DOM キャレットを置き、可視領域までスクロールする。
 * キャレット位置に一時的な marker を挿してそれを scrollIntoView した上で除去する（marker に
 * inline-block の大きさを持たせるのは WebKit 対応で、大きさの無いインライン要素は行頭・行末で
 * レイアウトボックスを持たず scrollIntoView が効かない）。marker の insertNode/remove は
 * テキストノードを分割・再結合するため、除去後の normalize で無効になった DOM 位置を
 * domPointForRawPosition で raw (line, col) から解決し直してからキャレットを置く。
 */
function setCaretAtRaw(line, col) {
  if (document.activeElement !== mdView) mdView.focus({ preventScroll: true });
  const point = domPointForRawPosition(line, col);
  if (!point) return;
  const marker = document.createElement('span');
  marker.style.cssText = 'display:inline-block;width:1px;height:1em;';
  const insertRange = document.createRange();
  insertRange.setStart(point.node, point.offset);
  insertRange.collapse(true);
  insertRange.insertNode(marker);
  marker.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const parent = marker.parentNode;
  marker.remove();
  parent?.normalize();

  const finalPoint = domPointForRawPosition(line, col);
  if (!finalPoint) return;
  const range = document.createRange();
  range.setStart(finalPoint.node, finalPoint.offset);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/** 閉じフェンスのコードブロックが編集の結果そのまま最終行になったら、その下に入力する場所が
 * 無くなる（コードブロックの中に入るしかない）ため、空行を1行追加して確保する。lines を
 * 直接書き換える。applyLines から呼ぶことで、追加した空行も元の編集と同じ splice に
 * 含まれ、undo 単位が増えない。 */
function ensureTrailingLineAfterClosedFence(lines) {
  const lastLine = lines.length - 1;
  for (const { end, closed } of scanFenceRanges(lines).values()) {
    if (closed && end === lastLine) {
      lines.push('');
      return;
    }
  }
}

/** 行構成そのものが変わる編集（splice 系）の共通後処理。 */
function applyLines(lines, caretLine, caretCol) {
  ensureTrailingLineAfterClosedFence(lines);
  rawContent = lines.join('\n');
  // reveal 対象を再描画の前に確定させる（renderAll → placeCaretAtRaw を、まだ古い revealState の
  // ままの 1 回で済ませる）。selectionchange の再判定だけに任せると、reveal 境界が動き続ける位置
  // （例: リンクの URL 内で打鍵し続ける）で「一旦ずれた状態を描画 → 非同期に selectionchange で
  // 補正」という 2 段構えになり、次の打鍵がその補正と競合しうる（詳細は computeRevealTarget 参照）
  revealState = computeRevealTarget(caretLine, caretCol);
  renderAll();
  placeCaretAtRaw(caretLine, caretCol);
  scheduleSave();
}

// ── Click → Caret ──────────────────────────────────
// #markdown-view 自体が contenteditable なので、通常のテキスト行のクリックはネイティブの
// クリック→キャレット配置に任せる（介入しない）。ここで扱うのは、ネイティブ配置に任せられない
// 3 ケースだけ: 画像クリック（選択状態にする）・画像のみの行の余白クリック（同上）・
// [data-line] の外側（余白）クリック（最終行の行末へ）。

mdView.addEventListener('mouseup', (e) => {
  // 画像リサイズのドラッグ確定はここでは扱わない（別のリスナーが担当）
  if (dragState) return;
  // リンクの中（画像を包むリンクも含む）はリンク側のクリック処理に一本化する
  if (e.target.closest('a[data-url]') || e.target.closest('input[type="checkbox"]')) return;
  // 範囲選択したときはこのハンドラで何もしない（コピーの邪魔をしない）
  if (!window.getSelection().isCollapsed) return;

  // 画像本体のクリックは選択状態にする（ダブルクリックで開く・右クリックメニュー・
  // リサイズハンドルとは独立に共存する）
  const img = e.target.closest('img[data-rel-src]');
  if (img) {
    const relSrc = img.dataset.relSrc;
    const lineEl = img.closest('[data-line]');
    if (isValidImageRelPath(relSrc) && lineEl) {
      selectImage(Number(lineEl.dataset.line), imageOccurrenceInLine(lineEl, img, relSrc), relSrc);
    }
    return;
  }

  const el = e.target.closest('[data-line]');
  const lines = getLines();
  if (!el) {
    // 余白クリックは最終行の行末へ
    placeCaretAtRaw(lines.length - 1, null);
    return;
  }
  if (el.dataset.lineEnd != null) return; // フェンス内はネイティブ配置に任せる
  const lineIdx = Number(el.dataset.line);
  if (isImageOnlyLine(lines[lineIdx] ?? '')) {
    // 画像のみの行の余白クリックも placeCaretAtRaw の関所が選択状態にする
    placeCaretAtRaw(lineIdx, null);
    return;
  }
  // 通常のテキスト行はネイティブのクリック→キャレット配置に任せる。以前の画像選択だけ解く
  clearImageSelection();
});

// リンクのクリックはネイティブ既定のキャレット配置を起こさない。mousedown で先に止めておかないと
// click 到達までの間にキャレットがリンクの中へ入り、インライン生表示（reveal）が発火して
// リンクが生 raw 表示に切り替わる（WebKit では click 到達前に selectionchange の再描画が間に合ってしまい、
// 再描画後の座標に click が飛んで shell.open が呼ばれない実害が出る）。抑止するのは主ボタンの単クリック
// （button===0・修飾キーなし・detail===1）だけに絞り、ダブルクリックの語選択・右クリックメニュー・
// 修飾キー付きクリック（新規タブで開く等）はブラウザ既定に任せる。ドラッグ選択の開始点がリンク上に
// あるケースは、mousedown 時点では単クリックとの区別が付かないため単クリック側を優先し、対応していない
// （リンク上から選択を始めたいドラッグは未対応のまま残る）
mdView.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.detail !== 1 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (e.target.closest('a[data-url]')) e.preventDefault();
});

mdView.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-url]');
  if (!link) return;
  e.preventDefault();
  window.__TAURI__.shell.open(link.dataset.url);
});

// 画像ダブルクリック → OS の既定アプリで開く
mdView.addEventListener('dblclick', (e) => {
  // 画像リサイズのドラッグ中は open_image を発火させない
  if (dragState) return;
  const img = e.target.closest('img[data-rel-src]');
  if (!img) return;
  // リンクの中の画像（[![alt](img)](url)）はリンク側のクリック処理に一本化する。
  // ここで開くと open_image とブラウザでのリンク遷移が同時に走ってしまう
  if (img.closest('a[data-url]')) return;
  const relSrc = img.dataset.relSrc;
  if (!isValidImageRelPath(relSrc)) return;
  fireInvoke('open_image', { imagePath: relSrc }, I18N.t('toastOpenImageFailed'));
});

// Checkbox toggle
mdView.addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  const lineIdx = parseInt(e.target.dataset.line, 10);
  const lines = getLines();
  if (e.target.checked) {
    lines[lineIdx] = lines[lineIdx].replace(/^(\s*)([-*] )\[ \] /, '$1$2[x] ');
  } else {
    lines[lineIdx] = lines[lineIdx].replace(/^(\s*)([-*] )\[x\] /i, '$1$2[ ] ');
  }
  rawContent = lines.join('\n');
  saveNow();
  // DOM の該当チェックボックス要素だけ更新（全体再レンダリング不要）
  const span = e.target.closest('.md-check');
  if (span) {
    span.classList.toggle('checked', e.target.checked);
  } else {
    renderAll();
  }
});

// ── Zoom ──────────────────────────────────────────
function applyZoom(zoom) {
  document.getElementById('note').style.zoom = zoom / 100;
  // ズーム変更でハンドルの座標系（rect と画面 px の対応）が変わるので位置合わせをやり直す
  hideHandle();
}

let currentZoom = 100;

async function changeZoom(delta) {
  const next = Math.max(50, Math.min(200, currentZoom + delta * 10));
  if (next === currentZoom) return;
  currentZoom = next;
  applyZoom(next);
  fireInvoke('update_note_zoom', { id: noteId, zoom: next }, I18N.t('toastSaveFailed'));
}

// ── Image Resize ──────────────────────────────────
// markdown.js の IMAGE_WIDTH_MIN/MAX（40〜2000）と揃える。ここより広い値を保存すると
// markdown.js が幅指定を無視し、再描画のたびに幅が消えてしまう
const IMAGE_RESIZE_MIN = 40;
const IMAGE_RESIZE_MAX = 2000;

// 共有 1 要素を画像ごとに位置だけ動かして使い回す（img 自体は置換要素で ::after が使えない）。
// mdView.innerHTML を丸ごと差し替える renderAll() で消えないよう mdView の外（body 直下）に置き、
// position: fixed でビューポート座標に直接置く（mdView のスクロールの影響を受けない）。
const resizeHandle = document.createElement('div');
resizeHandle.className = 'img-resize-handle';
document.body.appendChild(resizeHandle);

let dragState = null; // { img, relSrc, startX, startWidth, zoomFactor, maxWidth, currentWidth }
let hoverImg = null; // ハンドル表示中に位置合わせした画像（ドラッグ対象の特定に使う）

function positionHandle(img) {
  const rect = img.getBoundingClientRect();
  resizeHandle.style.left = `${rect.right - 5}px`;
  resizeHandle.style.top = `${rect.bottom - 5}px`;
}

function hideHandle() {
  hoverImg = null;
  resizeHandle.classList.remove('visible');
}

// mouseenter/leave は bubble しないので、mdView での委譲は mouseover を使う
mdView.addEventListener('mouseover', (e) => {
  if (dragState) return;
  const img = e.target.closest('img[data-rel-src]');
  // リモート URL 等、書き戻し先を特定できない画像にはハンドルを出さない
  if (!img || !isValidImageRelPath(img.dataset.relSrc)) return;
  hoverImg = img;
  positionHandle(img);
  resizeHandle.classList.add('visible');
});

// mdView から出た場合の隠し忘れをケアする。ハンドルは mdView の外（body 直下）にあるので、
// 画像の右下からハンドルへ移動する経路は mdView を一度離れる（relatedTarget がハンドルならまだ隠さない）
mdView.addEventListener('mouseleave', (e) => {
  if (dragState || e.relatedTarget === resizeHandle) return;
  hideHandle();
});

// ハンドルから離れた先が画像でなければ隠す（mdView の mouseover では拾えない遷移）
resizeHandle.addEventListener('mouseleave', (e) => {
  if (dragState) return;
  if (e.relatedTarget?.closest?.('img[data-rel-src]')) return;
  hideHandle();
});

// スクロールすると画像とハンドルの対応がずれるので、位置合わせをやり直す前提で一旦隠す
mdView.addEventListener('scroll', () => hideHandle());

/**
 * line 中でバッククォート 1 組（`...`）に囲まれた区間（開始・終了のバッククォートを含む）を
 * 列挙する。markdown.js の inlineMarkdown が code を先に保護してから画像記法を解釈するのと
 * 同じ解釈で、区間内の `![alt](src)` は画像記法として数えない（occurrence の定義を DOM 側
 * ＝実際に <img> として描画されるものと一致させる）。
 */
function codeSpanRanges(line) {
  const ranges = [];
  const re = /`[^`]+`/g;
  let m;
  while ((m = re.exec(line))) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function isInCodeSpan(ranges, pos) {
  return ranges.some(([start, end]) => pos >= start && pos < end);
}

/** 行 lineIdx の Markdown 記法のうち、relSrc と一致する occurrence 番目（0始まり）の画像記法だけ `|width` を追加・置換する。 */
function rewriteImageWidth(line, relSrc, width, occurrence) {
  const codeSpans = codeSpanRanges(line);
  let seen = -1;
  return line.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, src, offset) => {
    if (isInCodeSpan(codeSpans, offset)) return whole;
    if (src !== relSrc) return whole;
    seen++;
    if (seen !== occurrence) return whole;
    const base = alt.replace(/\|\d+$/, '');
    return `![${base}|${width}](${src})`;
  });
}

/** 行 lineEl 内で、relSrc が一致する img のうち img が何番目か（0始まり）。 */
function imageOccurrenceInLine(lineEl, img, relSrc) {
  const sameSrcImages = Array.from(lineEl.querySelectorAll('img[data-rel-src]'))
    .filter(el => el.dataset.relSrc === relSrc);
  return Math.max(0, sameSrcImages.indexOf(img));
}

/** ドラッグ確定時の書き戻し。 */
function applyImageWidth(img, relSrc, width) {
  const lineEl = img.closest('[data-line]');
  const lineIdx = lineEl ? Number(lineEl.dataset.line) : null;
  const occurrence = lineEl ? imageOccurrenceInLine(lineEl, img, relSrc) : 0;
  if (lineIdx == null) return;
  const lines = getLines();
  if (lineIdx < 0 || lineIdx >= lines.length) return;
  const rewritten = rewriteImageWidth(lines[lineIdx], relSrc, width, occurrence);
  if (rewritten === lines[lineIdx]) return;
  lines[lineIdx] = rewritten;
  rawContent = lines.join('\n');
  renderAll();
  saveNow();
}

/**
 * 画像の現在の canonical 幅（ズーム影響を除いた値）。width 属性を優先しつつ、
 * max-width: 100% で実表示が切り詰められている場合は実測幅（の canonical 換算）を使う。
 * ここがずれるとハンドルの表示位置とドラッグ開始幅が食い違い、ドラッグ開始直後に
 * 画像が無反応/ジャンプして見える。
 */
function currentImageWidth(img, zoomFactor) {
  const attrWidth = parseInt(img.getAttribute('width'), 10);
  const rect = img.getBoundingClientRect();
  const renderedWidth = rect.width > 0 ? rect.width / zoomFactor : null;
  if (Number.isFinite(attrWidth) && attrWidth > 0) {
    return renderedWidth != null ? Math.min(attrWidth, renderedWidth) : attrWidth;
  }
  if (renderedWidth != null) return renderedWidth;
  return 200; // 読み込み前・壊れた画像などで実測幅が取れない場合のフォールバック
}

function onResizeMouseMove(e) {
  if (!dragState) return;
  // mouseup を取りこぼした（ウィンドウ外での release 等）場合の自己回復。
  // 残ったままだと dragState 非 null のガードでクリック・dblclick・ホバーが全部無反応になる
  if (e.buttons === 0) {
    onResizeMouseUp();
    return;
  }
  const dx = e.clientX - dragState.startX;
  const raw = dragState.startWidth + dx / dragState.zoomFactor;
  dragState.currentWidth = Math.round(Math.min(Math.max(raw, IMAGE_RESIZE_MIN), dragState.maxWidth));
  dragState.img.style.width = `${dragState.currentWidth}px`;
  positionHandle(dragState.img);
}

function onResizeMouseUp() {
  const state = dragState;
  document.removeEventListener('mousemove', onResizeMouseMove);
  dragState = null;
  hideHandle();
  if (!state || state.currentWidth == null) return; // 実質的な移動が無ければ書き換えない
  applyImageWidth(state.img, state.relSrc, state.currentWidth);
}

// ウィンドウ外へドラッグしたまま release される等で mouseup が届かないケースの保険
window.addEventListener('blur', () => {
  if (dragState) onResizeMouseUp();
});

resizeHandle.addEventListener('mousedown', (e) => {
  if (!hoverImg) return;
  const relSrc = hoverImg.dataset.relSrc;
  if (!isValidImageRelPath(relSrc)) return;
  e.preventDefault();
  e.stopPropagation();
  const zoomFactor = currentZoom / 100;
  dragState = {
    img: hoverImg,
    relSrc,
    startX: e.clientX,
    startWidth: currentImageWidth(hoverImg, zoomFactor),
    zoomFactor,
    // 付箋が極端に狭いとき clientWidth が下限を割り込むことがあるため、上限は必ず下限以上にする
    maxWidth: Math.max(IMAGE_RESIZE_MIN, Math.min(mdView.clientWidth || IMAGE_RESIZE_MAX, IMAGE_RESIZE_MAX)),
    currentWidth: null,
  };
  document.addEventListener('mousemove', onResizeMouseMove);
  document.addEventListener('mouseup', onResizeMouseUp, { once: true });
});

// ── Paste 変換ユーティリティ ──────────────────────
// リッチテキスト → Markdown 変換そのものは beforeinput の編集経路と独立した純粋関数群。
// caret への合流は toMarkdown・下記の document 'paste' リスナーが担う。htmlToMarkdown 単体は
// window.htmlToMarkdown として引き続きテストから直接呼べる。
const EMPTY_IMAGE_MAP = new Map();

// Rust 側 save_pasted_image の上限（src-tauri/src/persistence.rs の MAX_IMAGE_BYTES）と揃える。
// atob() でのデコードは全体をメモリ上に展開するため、送る前に base64 の文字数から概算して弾く。
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DATA_URI_TOO_LARGE = Symbol('data-uri-too-large');

/**
 * alt / リンクテキストとして使う HTML 属性値を Markdown として安全な形に無害化する。
 * `]` を残すと `![alt](src)` / `[alt](src)` の終端と衝突し記法ごと壊れるため取り除く
 * （エスケープではなく除去。markdown.js の `[^\]]*` も Rust 側の extract_image_paths も
 * バックスラッシュエスケープを解釈しない）。改行は 1 行の記法を壊すため空白に置換する。
 */
function sanitizeAltText(text) {
  return text.replace(/\r\n|\r|\n/g, ' ').replace(/]/g, '');
}

/**
 * 画像記法（`![alt](src)`）の alt にだけ適用する追加の無害化。末尾が `|数字` になると
 * markdown.js の parseImageAlt が表示幅指定と誤解釈するため `|` を除去する。
 * リンクテキストとして使う場合（https 画像のフォールバックなど）は幅記法と無関係なので
 * sanitizeAltText のみを使い、`|` はそのまま残す。
 */
function sanitizeImageAlt(text) {
  return sanitizeAltText(text).replace(/\|/g, '');
}

/** URL 側（href / src）に改行が入ると Markdown 記法が複数行に割れるため取り除く。 */
function sanitizeUrl(url) {
  return url.replace(/\r\n|\r|\n/g, '');
}

/** `src` 属性値が `data:` スキームかどうか（大文字小文字を無視）。 */
function isDataUri(src) {
  return /^data:/i.test(src);
}

/**
 * `data:<media-type>;base64,<data>` 形式をデコードする（`;charset=...;base64,` のような
 * 追加パラメータや `BASE64,` / `DATA:` の大文字小文字表記も許容）。
 * 戻り値: 成功時は Uint8Array、base64 でない・デコード不能なら null（無言で alt にフォールバック）、
 * デコード後サイズが Rust 側の上限を超える見込みなら DATA_URI_TOO_LARGE（呼び出し側でトースト対象）。
 */
function decodeDataUri(src) {
  const match = /^data:([^,]*);base64,([\s\S]*)$/i.exec(src);
  if (!match) return null;
  const base64 = match[2];
  if (Math.floor((base64.length * 3) / 4) > MAX_IMAGE_BYTES) return DATA_URI_TOO_LARGE;
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * `<img src="data:...">` を `save_pasted_image` へ流し、src → 相対パスの Map を返す。
 * 同じ src が複数回出てきても保存は 1 回だけ。デコード不能（URL エンコード形式等）な src は
 * 無言で null を積み、呼び出し側で alt テキストのみのフォールバックに回す。サイズ超過・保存失敗は
 * 件数をまとめて数え、ループ終了後にトーストを 1 回だけ出す（画像ごとに出すとうるさいため）。
 */
async function resolveDataImages(srcs) {
  const map = new Map();
  let failures = 0;
  for (const src of srcs) {
    if (map.has(src)) continue;
    const decoded = decodeDataUri(src);
    if (decoded === null) {
      map.set(src, null);
      continue;
    }
    if (decoded === DATA_URI_TOO_LARGE) {
      console.error('data: image exceeds size limit, skipping:', src.slice(0, 32));
      failures++;
      map.set(src, null);
      continue;
    }
    try {
      map.set(src, await invoke('save_pasted_image', decoded));
    } catch (err) {
      console.error('save_pasted_image failed:', err);
      failures++;
      map.set(src, null);
    }
  }
  if (failures) showToast(I18N.t('toastSaveFailed'));
  return map;
}

function renderNodesToMd(nodes, imageMap) {
  let result = '';
  for (const node of nodes) result += nodeToMd(node, imageMap);
  return result;
}

/**
 * HTML 内に `<img src="data:...">` が無ければ同期で文字列を返す。ある場合だけ
 * `save_pasted_image` の待ち合わせが必要になるため Promise<string> を返す。
 * 呼び出し側（toMarkdown 経由）は戻り値が Promise かどうかで同期/非同期を分岐する。
 */
function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const dataImgSrcs = Array.from(doc.querySelectorAll('img'))
    .map(img => img.getAttribute('src') || '')
    .filter(isDataUri);
  if (!dataImgSrcs.length) {
    return renderNodesToMd(doc.body.childNodes, EMPTY_IMAGE_MAP);
  }
  return resolveDataImages(dataImgSrcs).then(map => renderNodesToMd(doc.body.childNodes, map));
}

/**
 * リッチテキストなら markdown に変換し、そうでなければプレーンテキストを返す。
 * 変換結果が空／空白のみ（blob: / file: 画像だけで alt も無い等）になった場合は、
 * 挿入が完全に消えてしまわないよう text にフォールバックする（同期・非同期どちらの経路でも）。
 */
function toMarkdown(text, html) {
  if (!html || !/<(?:a|strong|b|em|i|del|s|code|pre|h[1-3]|blockquote|[uo]l|li|hr|img)\b/i.test(html)) {
    return text;
  }
  const converted = htmlToMarkdown(html);
  if (converted instanceof Promise) {
    return converted.then(md => (md.trim() ? md : text));
  }
  return converted.trim() ? converted : text;
}

/**
 * <pre>(内側に <code> があればその中身、無ければ <pre> 自身)のテキストをフェンス（```）で
 * 囲んで返す。renderMarkdown のフェンス記法は行内に他の要素が無い前提の単純な正規表現
 * （note-lines.js 参照）なので、内部の <span> 等の装飾タグは textContent で読み捨てて
 * プレーンテキストへ潰す（構文ハイライト用にトークンごと <span> で包む貼り付け元でも、
 * コード内容自体の改行・空白はそのまま残る）。
 */
function preToMd(node) {
  const code = node.querySelector('code');
  const text = (code || node).textContent.replace(/\n$/, '');
  return text ? '```\n' + text + '\n```\n' : '';
}

/**
 * @param depth リスト入れ子の深さ（1 が最上位）。ul/ol の子（li）へ入るときだけ +1 する。
 *   li はこの深さから 2 スペース単位のインデントを算出する（markdown.js 側の入れ子判定と対応）。
 */
function nodeToMd(node, imageMap, depth = 0) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  // Strip script/style tags entirely — their text content is never useful
  if (tag === 'script' || tag === 'style') return '';
  if (tag === 'pre') return preToMd(node);
  const childDepth = (tag === 'ul' || tag === 'ol') ? depth + 1 : depth;
  const inner = Array.from(node.childNodes).map(child => nodeToMd(child, imageMap, childDepth)).join('');
  switch (tag) {
    case 'a': {
      const href = node.getAttribute('href') || '';
      if (!href || /^javascript:/i.test(href)) return inner;
      const url = sanitizeUrl(href);
      return `[${inner.trim() || url}](${url})`;
    }
    case 'strong': case 'b':  return inner ? `**${inner}**` : '';
    case 'em': case 'i':      return inner ? `*${inner}*` : '';
    case 'del': case 's':     return inner ? `~~${inner}~~` : '';
    case 'code':               return inner ? `\`${inner}\`` : '';
    case 'h1':                 return inner ? `# ${inner}\n` : '';
    case 'h2':                 return inner ? `## ${inner}\n` : '';
    case 'h3':                 return inner ? `### ${inner}\n` : '';
    case 'blockquote':         return inner ? inner.split('\n').filter(l => l).map(l => `> ${l}`).join('\n') + '\n' : '';
    case 'ul': case 'ol':     return inner;
    case 'li': {
      // 自身のインライン内容とネストした <ul>/<ol> を分けて処理する。混ぜて inner のまま
      // 出すと、ネストしたリストが改行・インデント無しで自身の文末に連結され
      // "- parent- child" のように潰れる
      const parent = node.parentElement?.tagName.toLowerCase();
      const ownNodes = Array.from(node.childNodes)
        .filter((c) => !(c.nodeType === Node.ELEMENT_NODE && ['UL', 'OL'].includes(c.tagName)));
      const nestedLists = Array.from(node.children).filter((c) => ['UL', 'OL'].includes(c.tagName));
      const ownText = ownNodes.map((c) => nodeToMd(c, imageMap, depth)).join('').trim();
      const nestedMd = nestedLists.map((c) => nodeToMd(c, imageMap, depth)).join('');
      const indent = '  '.repeat(Math.max(0, depth - 1));
      const marker = parent === 'ol'
        ? `${Array.from(node.parentElement.children).indexOf(node) + 1}. `
        : '- ';
      return `${indent}${marker}${ownText}\n${nestedMd}`;
    }
    case 'br':                 return '\n';
    case 'hr':                 return '---\n';
    case 'p': case 'div':     return inner + '\n';
    // CSP の img-src が https を許可していないため、リモート URL は画像記法にせずリンクにする。
    // data: は resolveDataImages が保存済みの相対パスに解決済み（未解決なら alt のみ残す）。
    // blob: / file: 等はそもそも取り込まず alt のみ残す。
    case 'img': {
      const rawAlt = node.getAttribute('alt') || '';
      const src = node.getAttribute('src') || '';
      if (isDataUri(src)) {
        const relPath = imageMap.get(src);
        // 画像記法として出す場合のみ `|` も除去する（幅指定との誤解釈を防ぐため）
        return relPath ? `![${sanitizeImageAlt(rawAlt)}](${relPath})` : sanitizeAltText(rawAlt);
      }
      if (/^https?:\/\//i.test(src)) {
        const url = sanitizeUrl(src);
        const alt = sanitizeAltText(rawAlt);
        return `[${alt || url}](${url})`;
      }
      return sanitizeAltText(rawAlt);
    }
    default:                   return inner;
  }
}

/** File を save_pasted_image で保存し、生成された相対パスを返す。失敗時は null
 * （トースト表示済み）。ドロップ・caret へのペースト両方の画像挿入が共有する。 */
async function savePastedImage(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return await invoke('save_pasted_image', bytes);
  } catch (err) {
    console.error('save_pasted_image failed:', err);
    showToast(I18N.t('toastSaveFailed'));
    return null;
  }
}

/**
 * ドロップ画像を保存し、生成された相対パスを Markdown 画像記法として fallbackLine の行末へ
 * 追記する（ドロップ先は座標であって caret ではないため、行末追記が唯一の妥当な挿入位置）。
 */
async function pasteImage(file, fallbackLine) {
  const relPath = await savePastedImage(file);
  if (!relPath) return;
  const markdown = `![](${relPath})`;
  const lines = getLines();
  const target = Math.min(Math.max(fallbackLine ?? lines.length - 1, 0), lines.length - 1);
  lines[target] += markdown;
  rawContent = lines.join('\n');
  renderAll();
  await saveNow();
}

/** 画像 File を順番どおりに挿入する。挿入のたびに行番号がずれるため並列にはできない。 */
async function pasteImageFiles(files, fallbackLine) {
  for (const file of files) await pasteImage(file, fallbackLine);
}

/** ドロップ先の要素から挿入対象の行番号を求める。フェンスは行単位のマッピングを持たないので末尾に置く。 */
function dropTargetLine(target) {
  const el = target.closest('[data-line]');
  if (!el) return null;
  return el.dataset.lineEnd != null ? Number(el.dataset.lineEnd) : Number(el.dataset.line);
}

// ── Drop ────────────────────────────────────────────
// 画像ファイルのドロップは保存して該当行へ追記する。preventDefault（File ドラッグのみ）は
// 先頭の dragover/drop リスナーが担う
document.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  const imageFiles = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
  // renderAll() で DOM が作り直される前に、ドロップ先の行番号を確定させておく
  const fallbackLine = dropTargetLine(e.target);
  if (!imageFiles.length) {
    showToast(I18N.t('toastImageDropUnsupported'));
    return;
  }
  await pasteImageFiles(imageFiles, fallbackLine);
});

/** clientX/Y から mdView 内の DOM 位置（node, offset）を解決する。document.caretRangeFromPoint は
 * 非標準（Firefox は caretPositionFromPoint を使う）だが、テスト対象の chromium・webkit 両方で
 * 動く。対応していない・その座標に文字位置が無ければ null。 */
function domPointFromClientPoint(x, y) {
  if (typeof document.caretRangeFromPoint !== 'function') return null;
  const range = document.caretRangeFromPoint(x, y);
  if (!range) return null;
  return { node: range.startContainer, offset: range.startOffset };
}

/** ドロップの挿入対象 bounds（collapsed）。座標（e.clientX/Y）を raw 位置へ解決できればその点、
 * 解決できなければ末尾にフォールバックする。 */
function dropInsertionBounds(e) {
  const domPoint = domPointFromClientPoint(e.clientX, e.clientY);
  const point = domPoint ? resolveSelectionPoint(domPoint.node, domPoint.offset, false) : null;
  if (point) return { start: point, end: { ...point } };
  const lines = getLines();
  const end = { line: lines.length - 1, col: lines[lines.length - 1].length };
  return { start: end, end: { ...end } };
}

// テキストのドラッグ&ドロップはコピー意味論（ドラッグ元のテキストは削除しない）で合流する。
// ドロップ座標（clientX/Y）を caretRangeFromPoint 経由で raw 位置へ解決し、その位置へ挿入する
// （解決できなければ末尾へ追記）。ネイティブに任せると contenteditable の DOM だけが書き換わり
// rawContent との整合が崩れるため、常にブラウザ既定は止める
document.addEventListener('drop', (e) => {
  if (isFileDrag(e)) return;
  if (!mdView.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  const text = e.dataTransfer.getData('text/plain');
  if (!text) return;
  commitSelectionReplacement(dropInsertionBounds(e), text);
}, true);

// ── Auto-Save Content ─────────────────────────────
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

// 不変条件: rawContent を書き換える経路は、必ずここ（saveNow の commit）か
// 明示的な editHistory.commit 呼び出し（removeSelectedImage 等）のどちらかを通ること。
// どちらも通らない経路があると、その変更へは undo/redo で戻れない
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  // 保存が確定するたびに undo 履歴へ積む（undo/redo 自身の書き戻しは commit と同値になるため
  // 履歴側の同値ガードで無視される）
  editHistory?.commit(rawContent);
  return fireInvoke('update_note_content', { id: noteId, content: rawContent }, I18N.t('toastSaveFailed'));
}

/** デバウンス中の保存を確定させ、完了を待つ。rawContent は常に最新なので、
 * 保留中のタイマーがあればここで確定させるだけでよい。 */
function flushContent() {
  if (!saveTimer) return Promise.resolve();
  return saveNow();
}

// ── Undo / Redo ────────────────────────────────────────────
// 適用中の多重発火を防ぐ（deletingImage と同じ考え方）。⌘Z の押しっぱなしや
// メニューイベントの二重到達があっても history の巻き戻りが 1 回で済むようにする
let applyingHistory = false;

/** history から返った content を適用し、差分行にキャレットを置いて保存する共通処理。 */
async function applyHistoryContent(prevContent, content) {
  if (content == null) return;
  clearImageSelection();
  rawContent = content;
  renderAll();
  const diffLine = firstDiffLine(prevContent, content);
  if (diffLine != null) {
    placeCaretAtRaw(Math.min(diffLine, getLines().length - 1), null);
  }
  await saveNow();
}

// deletingImage 中（画像削除の確認ダイアログ待ち・invoke 待ち）は rawContent が
// removeSelectedImage の完了を待たずに undo/redo で上書きされると内容が乖離するため、
// 完了するまで no-op にする（相互チェックは removeSelectedImage 側の applyingHistory 判定と対）
async function performUndo() {
  if (composing || applyingHistory || deletingImage || !editHistory) return;
  applyingHistory = true;
  try {
    await flushContent();
    const prevContent = rawContent;
    await applyHistoryContent(prevContent, editHistory.undo(prevContent));
  } finally {
    applyingHistory = false;
  }
}

async function performRedo() {
  if (composing || applyingHistory || deletingImage || !editHistory) return;
  applyingHistory = true;
  try {
    await flushContent();
    const prevContent = rawContent;
    await applyHistoryContent(prevContent, editHistory.redo(prevContent));
  } finally {
    applyingHistory = false;
  }
}

// WebView 標準の undo/redo（NSUndoManager 経由）は edit_submenu をカスタム MenuItem に
// 置き換えたことで発火経路が無いはずだが、念のための保険として二重に止める
document.addEventListener('beforeinput', (e) => {
  if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') e.preventDefault();
});

// ── beforeinput ディスパッチャ ──────────────────────
// #markdown-view への編集はすべて beforeinput で受け、実装済みの inputType（insertText /
// deleteContentBackward / deleteContentForward / insertParagraph / insertLineBreak）だけを
// ブラウザの既定編集をやめて splice → 再描画へ差し替える。それ以外（insertReplacementText・
// insertFromPaste 等）は fail-closed で無視する。
// composition 中（cancelable でない beforeinput）は介入せず、compositionend でまとめて反映する。

/** 現在の DOM 選択の Range（無ければ null）。 */
function currentSelectionRange() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  return sel.getRangeAt(0);
}

mdView.addEventListener('beforeinput', (e) => {
  if (composing) return;
  if (suppressPostCompositionInput && (e.inputType === 'insertText' || e.inputType === 'insertParagraph')) {
    // 確定 Enter 二重処理ガード（markPostCompositionSuppression 参照）。compositionend が
    // 既に確定文字列を splice 済みなので、ここでの適用は捨てる
    if (e.cancelable) e.preventDefault();
    return;
  }
  if (!e.cancelable) {
    // composition 外の非 cancelable な beforeinput（一部の IME・自動置換等）は preventDefault
    // できず、ネイティブ編集がそのまま DOM に適用されてしまう。rawContent は変えないまま、
    // ネイティブ適用後の次のマイクロタスクで DOM を rawContent の状態へ描画し直して巻き戻す
    const range = currentSelectionRange();
    const point = range ? resolveSelectionPoint(range.startContainer, range.startOffset, false) : null;
    queueMicrotask(() => {
      renderAll();
      if (point) placeCaretAtRaw(point.line, point.col);
    });
    return;
  }
  const inputType = e.inputType;
  const known = inputType === 'insertText' || inputType === 'deleteContentBackward'
    || inputType === 'deleteContentForward' || inputType === 'deleteContent'
    || inputType === 'insertParagraph' || inputType === 'insertLineBreak';
  if (!known) {
    e.preventDefault(); // 未実装の inputType は fail-closed で無視する
    return;
  }
  e.preventDefault();
  try {
    if (inputType === 'insertText') onInsertText(e.data ?? '');
    else if (inputType === 'insertParagraph') onInsertParagraph();
    else if (inputType === 'insertLineBreak') onInsertLineBreak();
    // deleteContent は方向指定なしの削除（WebKit が選択のある ⌥Backspace 等で発火する）。
    // 選択がある間は onDeleteContent の direction 引数はどのみち使われない（選択削除のみ）ため
    // 'backward' で揃える
    else onDeleteContent(inputType === 'deleteContentForward' ? 'forward' : 'backward');
  } catch (err) {
    console.error('beforeinput handling failed:', err);
  }
});

/** node/offset より前に、mdView 内に可視文字が 1 つも無いかどうか。Range.collapsed は
 * 境界点の同一性判定（(parent, 0) と (firstChild, 0) は指す位置が同じでも境界点としては
 * 等しくない）のため使えない。範囲の文字列化が空文字列かどうかで判定する。 */
function isAtEditableStart(node, offset) {
  const r = document.createRange();
  r.setStart(mdView, 0);
  r.setEnd(node, offset);
  return r.toString() === '';
}

// WebKit は編集領域の絶対先頭での Backspace に対して beforeinput を発火しない（直前に
// 削除対象が無いとネイティブ側で処理を打ち切るため）。見出し・引用の行頭マーカーは DOM 上に
// 文字として存在せず、先頭行ならマーカー直後がそのまま編集領域の絶対先頭になるため、
// beforeinput 抜きではマーカー解除が一切効かなくなる。keydown で同じ条件を検出し、
// beforeinput を経由せず直接 onDeleteContent を呼んで揃える。keydown を preventDefault する
// ので、beforeinput が発火する側（Chromium 等）で二重処理になることもない。
mdView.addEventListener('keydown', (e) => {
  if (composing || suppressPostCompositionInput) return;
  if (e.key !== 'Backspace' || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
  const range = currentSelectionRange();
  if (!range || !range.collapsed) return;
  if (!isAtEditableStart(range.startContainer, range.startOffset)) return;
  e.preventDefault();
  onDeleteContent('backward');
});

/** キャレット行、または選択が触れているすべての行の先頭に 2 スペースを足す/削る。リスト
 * マーカー・フェンス内容行を区別せず、行頭に対して機械的に作用する（リストマーカーは
 * インデントに押し出されるだけで記法自体は変えない）。bounds が複数行にまたがるときは、
 * indent 後に同じ行範囲を選択し直す。これをしないと applyLines が選択を collapsed キャレット
 * （先頭行）へ潰してしまい、Tab を連打しても先頭行しか字下げされ続けない。 */
function indentLines(bounds, outdent) {
  const lines = getLines();
  const { start, end } = bounds;
  const deltas = [];
  for (let i = start.line; i <= end.line; i++) {
    if (outdent) {
      const removed = Math.min(2, lines[i].match(/^ */)[0].length);
      lines[i] = lines[i].slice(removed);
      deltas[i] = -removed;
    } else {
      lines[i] = '  ' + lines[i];
      deltas[i] = 2;
    }
  }
  const caretCol = Math.max(0, start.col + deltas[start.line]);
  applyLines(lines, start.line, caretCol);
  if (end.line > start.line) {
    selectRawRange(start.line, caretCol, end.line, Math.max(0, end.col + deltas[end.line]));
  }
}

mdView.addEventListener('keydown', (e) => {
  if (composing || suppressPostCompositionInput) return;
  if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
  const bounds = resolveEditableBounds();
  // bounds を解決できない（キャレットが無い・画像選択中）ときは既定動作に任せ、
  // Tab でフォーカスをボタン列へ抜けられる経路を残す
  if (!bounds) return;
  e.preventDefault();
  indentLines(bounds, e.shiftKey);
});

/** 現在の選択から、挿入・置換の対象にする raw bounds を求める（判定フェーズ）。collapsed なら
 * collapsedBounds、非 collapsed なら resolveSelectionBounds。画像選択（selectImageRange が張った
 * Range）は img 自体が可視幅 0 のため、非 collapsed な選択でも raw bounds が同じ点に潰れて退化する。
 * ここで無視しないと、画像を消さずにその raw 位置へ文字だけ挿入してしまう（画像は残ったまま隣に
 * 文字が入る）。画像の置換は Backspace/Delete（removeSelectedImage、確認ダイアログ・Rust 側の
 * ファイル削除込み）に委ねる。 */
function resolveEditableBounds() {
  const range = currentSelectionRange();
  if (!range) return null;
  if (range.collapsed) return collapsedBounds(range);
  const bounds = resolveSelectionBounds(range);
  if (!bounds || boundsAreDegenerate(bounds)) return null;
  return bounds;
}

/** 打ち終えたチェックボックス記法（`- []`・`-[x]` 等）を `- [ ] `/`- [x] ` へ補完する。
 * line の行頭〜col が丸ごと CHECKBOX_RE に一致するときだけ発火する（マーカーの手前に
 * 他の文字があれば対象外）。フェンス内容行は splitLineAt 等と同じ findBlock 由来の inFence
 * 判定で対象外にする（コードとして書いた `- []` を書き換えない）。insertText の splice 直後に
 * 呼ぶことで、debounce 前の追加 splice として同じ undo 単位にまとまる。 */
function maybeAutocompleteCheckbox(line, col) {
  const block = findBlock(line);
  if (block && block.start !== block.end) return;
  const lines = getLines();
  const m = lines[line].slice(0, col).match(CHECKBOX_RE);
  if (!m) return;
  const replacement = m[2].toLowerCase() === 'x' ? `${m[1]} [x] ` : `${m[1]} [ ] `;
  lines[line] = replacement + lines[line].slice(col);
  applyLines(lines, line, replacement.length);
}

function onInsertText(data) {
  const bounds = resolveEditableBounds();
  if (!bounds) return;
  commitSelectionReplacement(bounds, data);
  if (data === ']') maybeAutocompleteCheckbox(bounds.start.line, bounds.start.col + data.length);
}

/** collapsed キャレット位置の bounds（start === end）。resolveSelectionBounds のマーカー境界
 * 正規化（選択の削除範囲向け。開始点が可視オフセット 0 ならマーカー込みへ切り詰める）は
 * 挿入位置には適用してはいけない（マーカー直後へ挿すべき文字がマーカーの前に入ってしまう）ため、
 * resolveSelectionPoint を直接使う。 */
function collapsedBounds(range) {
  const point = resolveSelectionPoint(range.startContainer, range.startOffset, false);
  if (!point) return null;
  return { start: point, end: { ...point } };
}

// ── Enter（insertParagraph・insertLineBreak）────────────────
// フェンス内判定は findBlock の data-line-end 有無（block.start !== block.end）で行う。
// collapsed キャレットは装飾記法・行頭マーカーの内部を指せない（visibleOffsetFromRawOffset の
// 境界規約）ため、col は常にマーカー長以上になる。非 collapsed（選択）経路はこの限りでない：
// resolveSelectionBounds が「開始点の可視オフセットが 0（マーカー直後）」の選択を
// マーカー込みの raw col 0 へ正規化するため、可視行頭を含む選択からの Enter では
// start.col がマーカー長を割り込み、splitLineAt の before にマーカーが残らない。
//
// 対応する閉じフェンスの無い ``` 行は常にリテラルのテキスト行として描画される
// （scanFenceRanges）ため、そのままではコードブロックを作る手段が無い。この行での Enter
// （insertParagraph、autoContinue）をコードブロック生成のトリガーとして扱う。キャレットの
// 列は問わない: 矢印キーでこの行に入るとキャレットは行頭に落ちることが多く（WebKit は移動元の
// 列を引き継ぐ）、行末限定にすると「Enter しても何も起きない」ように見えるため。

/** キャレットが、リテラルの ``` 単独行（```js のような言語指定つきも含む）を指しているか。
 * isFenceEnterTarget が真の行だけ splitLineAt がコードブロック自動生成に分岐する。 */
function isFenceEnterTarget(lines, start, end) {
  if (start.line !== end.line || start.col !== end.col) return false;
  return /^```\S*\s*$/.test(lines[start.line]);
}

/** bounds（resolveEditableBounds の結果）の位置で行を分割する。autoContinue が真なら
 * getAutoPrefix でリスト・引用のマーカーを次行へ引き継ぐ（フェンス内は対象外）。 */
function splitLineAt(bounds, autoContinue) {
  const { start, end } = bounds;
  const lines = getLines();

  const block = findBlock(start.line);
  const inFence = !!block && block.start !== block.end;

  if (autoContinue && !inFence && isFenceEnterTarget(lines, start, end)) {
    // 空の内容行 + 閉じフェンス行を生成し、キャレットを内容行に置く。1 回の splice に収めて
    // undo を 1 手にする。閉じフェンスが結果的に最終行になれば applyLines が末尾に空行を確保する
    lines.splice(start.line, 1, lines[start.line], '', '```');
    applyLines(lines, start.line + 1, 0);
    return;
  }

  const before = lines[start.line].slice(0, start.col);
  const after = lines[end.line].slice(end.col);
  const merged = before + after;

  const prefix = (autoContinue && !inFence) ? getAutoPrefix(merged) : null;

  if (prefix !== null && isEmptyListItem(merged)) {
    // 中身のないリスト項目 → プレフィックスを消して継続を打ち切る
    lines.splice(start.line, end.line - start.line + 1, '');
    applyLines(lines, start.line, 0);
    return;
  }

  const nextLineText = prefix === null ? after : prefix + after.replace(/^ /, '');
  lines.splice(start.line, end.line - start.line + 1, before, nextLineText);
  applyLines(lines, start.line + 1, prefix === null ? 0 : prefix.length);
}

function onInsertParagraph() {
  const bounds = resolveEditableBounds();
  if (!bounds) return;
  splitLineAt(bounds, true);
}

function onInsertLineBreak() {
  const bounds = resolveEditableBounds();
  if (!bounds) return;
  splitLineAt(bounds, false);
}

function onDeleteContent(direction) {
  const range = currentSelectionRange();
  if (!range) return;
  if (!range.collapsed) {
    const bounds = resolveDeletableBounds();
    if (bounds) commitSelectionDeletion(bounds);
    return;
  }
  const point = resolveSelectionPoint(range.startContainer, range.startOffset, false);
  if (!point) return;
  deleteAdjacentVisibleChar(point.line, point.col, direction);
}

/** 行 line の「可視行頭」に対応する raw 列。フェンス内容行は raw が可視テキストそのまま
 * （マーカーという概念が無い）なので 0、それ以外はマーカー長（見出し・リスト・引用の記号込み）。
 * 行頭 Backspace の段階解除・行末 Delete がどこを「境界」とみなすかの判定に使う。 */
function lineStartColumn(line) {
  const block = findBlock(line);
  if (block && block.start !== block.end) return 0;
  return markerLength(getLines()[line] ?? '');
}

/**
 * 可視行頭（raw col === lineStartColumn(line)）での Backspace。段階的に解除する:
 * 1) マーカーあり（マーカー長 > インデント）→ マーカーだけ除去（インデント維持）
 * 2) マーカーなしでインデントあり → インデント全除去
 * 3) どちらも無し → 前行と結合し、前行末尾へキャレット
 * フェンス内容行は 1)/2) の対象外（インデントは実コードの一部で、剥がすと内容が変わるため）で、
 * 最初の内容行の行頭ならコードブロック解除（フェンス 2 行を取り除き内容をプレーンテキストへ。
 * 見出し等の「1 回目 = 装飾解除」と対称）。
 * 前行がフェンス区切り（```）・画像のみの行は、結合すると記法が壊れるため no-op にする。
 */
function backspaceAtLineStart(line) {
  const lines = getLines();
  const lineText = lines[line];
  const block = findBlock(line);
  const inFence = !!block && block.start !== block.end;

  if (!inFence) {
    const indent = lineText.match(/^ */)[0].length;
    const markerLen = markerLength(lineText);
    if (markerLen > indent) {
      lines[line] = lineText.slice(0, indent) + lineText.slice(markerLen);
      applyLines(lines, line, indent);
      return;
    }
    if (indent > 0) {
      lines[line] = lineText.slice(indent);
      applyLines(lines, line, 0);
      return;
    }
  }

  if (inFence && line === block.start + 1) {
    // 最初の内容行の行頭 → コードブロック解除。閉じ → 開きの順に取り除く（先に開きを
    // 取ると閉じフェンスの行番号がずれる）。キャレットは同じ内容行の行頭に残る
    lines.splice(block.end, 1);
    lines.splice(block.start, 1);
    applyLines(lines, block.start, 0);
    return;
  }

  if (line === 0) return; // 先頭行はこれ以上結合できない
  const prevLine = lines[line - 1];
  // 開き/閉じの区別なく「```」で始まる行は全て弾く（言語指定つきの開きフェンス
  // 「```js」も含む）。どちらへ結合しても記法が壊れる点は同じで、区別する意味が無い
  if (/^```/.test(prevLine) || isImageOnlyLine(prevLine)) return;
  const mergeCol = prevLine.length;
  lines[line - 1] = prevLine + lineText;
  lines.splice(line, 1);
  applyLines(lines, line - 1, mergeCol);
}

/**
 * 行末（raw col === 行の長さ）での Delete。次行のマーカーを剥がして現在行へ連結する（1 段のみ）。
 * 次行がフェンス区切り（```）・画像のみの行は、結合すると記法が壊れるため no-op にする。
 */
function deleteAtLineEnd(line) {
  const lines = getLines();
  if (line >= lines.length - 1) return; // 最終行
  const nextLine = lines[line + 1];
  // 開き/閉じの区別なく「```」始まりを弾く（どちらへ連結しても記法が壊れるため）
  if (/^```/.test(nextLine) || isImageOnlyLine(nextLine)) return;
  const nextBlock = findBlock(line + 1);
  const nextInFence = !!nextBlock && nextBlock.start !== nextBlock.end;
  const markerLen = nextInFence ? 0 : markerLength(nextLine);
  const caretCol = lines[line].length;
  lines[line] = lines[line] + nextLine.slice(markerLen);
  lines.splice(line + 1, 1);
  applyLines(lines, line, caretCol);
}

/**
 * collapsed キャレット（行 line、raw 列 col）から direction 側に隣接する可視 1 文字ぶんの
 * raw 範囲を削除する。可視行頭での Backspace・行末での Delete は行構成そのものが変わるため、
 * それぞれ段階解除・次行連結（backspaceAtLineStart / deleteAtLineEnd）に委ねる。
 */
function deleteAdjacentVisibleChar(line, col, direction) {
  const lineText = getLines()[line] ?? '';
  if (direction === 'backward' && col <= lineStartColumn(line)) {
    backspaceAtLineStart(line);
    return;
  }
  if (direction === 'forward' && col >= lineText.length) {
    deleteAtLineEnd(line);
    return;
  }
  const markerLen = lineStartColumn(line);
  const range = adjacentVisibleCharRawRange(line, col, direction);
  if (!range) return;
  const bounds = {
    start: { line, col: markerLen + range.from },
    end: { line, col: markerLen + range.to },
  };
  commitSelectionReplacement(bounds, '');
}

/** セグメントの可視文字 → raw 文字の 1:1 対応表を返す（charMap があればそれを、無くても
 * raw==visible の素のセグメントなら等価な対応を組み立てる）。対応しない（画像・ネスト装飾等の
 * アトミックな）セグメントは null。 */
function effectiveCharMap(seg, inlineRaw) {
  if (seg.charMap) return seg.charMap;
  if (seg.visibleText === inlineRaw.slice(seg.srcStart, seg.srcEnd)) {
    return { srcStart: seg.srcStart, len: seg.visibleText.length };
  }
  return null;
}

const GRAPHEME_SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter() : null;

/** 文字列 s の書記素クラスタ列。Intl.Segmenter が無い環境（テスト等）では UTF-16 コード単位を
 * 1 書記素として扱うフォールバックにする。 */
function graphemesOf(s) {
  if (GRAPHEME_SEGMENTER) return [...GRAPHEME_SEGMENTER.segment(s)].map((g) => g.segment);
  return [...s];
}

/**
 * インライン部（マーカーを除いた raw 行の残り）の可視オフセット contentVisible から
 * direction 側に隣接する可視 1 書記素ぶんの raw 範囲 { from, to }（inlineRaw 上のオフセット）
 * を返す。charMap を持たない（アトミックな）セグメントに隣接する場合はセグメント全体の raw
 * 範囲を返す。隣接する可視文字が無ければ null。
 *
 * 可視長 0 のセグメント（画像等）は幅を持たず、隣り合うセグメントと同じ可視オフセットに
 * 境界が重なる。通常セグメントの不等号判定（内部に文字があること前提）ではこれを素通りして
 * しまうため、まず可視長 0 のセグメントだけを境界の完全一致で別途探す。複数の可視長 0
 * セグメントが同じ境界に並ぶ場合（連続する画像等）は、cursor に空間的に最も近いもの
 * （backward なら raw 上で最後、forward なら raw 上で最初）を選ぶ。
 */
function adjacentVisibleCharRawRange(line, col, direction) {
  const lineText = getLines()[line] ?? '';
  const markerLen = lineStartColumn(line);
  const inlineRaw = lineText.slice(markerLen);
  const reveal = revealRangeForLine(line);
  const contentVisible = visibleOffsetFromRawOffset(inlineRaw, Math.max(0, col - markerLen), reveal);
  const segments = inlineSegments(inlineRaw, reveal);

  let consumed = 0;
  const positioned = segments.map((seg) => {
    const segStartVisible = consumed;
    const segEndVisible = consumed + seg.visibleText.length;
    consumed = segEndVisible;
    return { seg, segStartVisible, segEndVisible };
  });

  const zeroLenMatch = direction === 'backward'
    ? [...positioned].reverse().find(({ seg, segEndVisible }) => seg.visibleText.length === 0 && segEndVisible === contentVisible)
    : positioned.find(({ seg, segStartVisible }) => seg.visibleText.length === 0 && segStartVisible === contentVisible);
  if (zeroLenMatch) return { from: zeroLenMatch.seg.srcStart, to: zeroLenMatch.seg.srcEnd };

  for (const { seg, segStartVisible, segEndVisible } of positioned) {
    if (seg.visibleText.length === 0) continue;
    if (direction === 'backward') {
      if (contentVisible <= segStartVisible || contentVisible > segEndVisible) continue;
      const map = effectiveCharMap(seg, inlineRaw);
      if (!map) return { from: seg.srcStart, to: seg.srcEnd };
      const before = seg.visibleText.slice(0, contentVisible - segStartVisible);
      const graphemes = graphemesOf(before);
      const last = graphemes[graphemes.length - 1];
      if (!last) return null;
      const from = map.srcStart + before.length - last.length;
      return { from, to: from + last.length };
    }
    if (contentVisible < segStartVisible || contentVisible >= segEndVisible) continue;
    const map = effectiveCharMap(seg, inlineRaw);
    if (!map) return { from: seg.srcStart, to: seg.srcEnd };
    const localStart = contentVisible - segStartVisible;
    const after = seg.visibleText.slice(localStart);
    const graphemes = graphemesOf(after);
    const first = graphemes[0];
    if (!first) return null;
    const from = map.srcStart + localStart;
    return { from, to: from + first.length };
  }
  return null;
}

// ── IME ───────────────────────────────────────────
// composition 中は WebKit がネイティブに DOM を書き換える（rawContent は真実のまま放置。
// beforeinput 側は composing フラグで全面的に不介入、keydown フォールバックも同様）。
// compositionend で、変換開始時点に退避した位置（compositionBounds）へ確定文字列を splice し、
// 再描画でネイティブの書き換えを丸ごと作り直す（巻き戻し兼用）。取消（e.data が空）は
// 再描画のみで、退避位置へキャレットを戻す。

/** IME 変換開始時点のキャレット/選択位置を bounds（{start,end}）として解決する。
 * 解決できなければ null（compositionend は現在の選択からの復元にフォールバックする）。 */
function resolveCompositionBounds() {
  const range = currentSelectionRange();
  if (!range) return null;
  try {
    return range.collapsed ? collapsedBounds(range) : resolveSelectionBounds(range);
  } catch (err) {
    console.error('composition bounds resolve failed:', err);
    return null;
  }
}

/** compositionend 直後の 1 マイクロタスクぶんだけ suppressPostCompositionInput を立てる。
 * WebKit は IME を Enter で確定すると、compositionend の直後・同一イベントループ内に確定内容と
 * 同じ挿入を beforeinput（insertText または insertParagraph）としてもう一度発火することがある
 * （composing は既に false のため、素通しすると二重挿入・意図しない改行になる）。マイクロタスクの
 * 区切りは実際のユーザー入力（別イベントループで届く）より確実に早く解除されるため、後続のタイピングを
 * 巻き込むことはない。 */
function markPostCompositionSuppression() {
  suppressPostCompositionInput = true;
  queueMicrotask(() => { suppressPostCompositionInput = false; });
}

/** IME 確定時の splice。commitSelectionReplacement 相当だが、window.getSelection().removeAllRanges()
 * を明示的には呼ばない。compositionend 直後はフォーカス済みの contenteditable で composition の
 * 装飾が畳まれている最中で、ここで選択を空にすると編集領域先頭へキャレットが合成された状態が
 * 一瞬でき、直後の renderAll・placeCaretAtRaw までの間にそれが可視化されるとキャレットが行頭へ
 * 飛んで見える。選択は renderAll の innerHTML 差し替えでどのみち無効化されるため、明示的な
 * removeAllRanges は不要。 */
function commitCompositionReplacement(bounds, insertedText) {
  clearImageSelection();
  spliceSelectionRange(bounds, insertedText);
}

mdView.addEventListener('compositionstart', () => {
  composing = true;
  suppressPostCompositionInput = false;
  compositionBounds = resolveCompositionBounds();
});

mdView.addEventListener('compositionend', (e) => {
  composing = false;
  markPostCompositionSuppression();
  const bounds = compositionBounds;
  compositionBounds = null;

  if (!bounds) {
    // 退避に失敗している（想定外）。現在の選択から可能な範囲でキャレット位置を読み取ってから
    // 巻き戻す
    const range = currentSelectionRange();
    const point = range ? resolveSelectionPoint(range.startContainer, range.startOffset, false) : null;
    renderAll();
    if (point) placeCaretAtRaw(point.line, point.col);
    return;
  }
  if (!e.data) {
    // 変換取消。rawContent は変わらないので、WebKit が composition 中に書き込んだ DOM を
    // 巻き戻し、キャレットを退避位置へ戻す
    renderAll();
    placeCaretAtRaw(bounds.start.line, bounds.start.col);
    return;
  }
  try {
    commitCompositionReplacement(bounds, e.data);
  } catch (err) {
    console.error('composition commit failed:', err);
    renderAll();
    placeCaretAtRaw(bounds.start.line, bounds.start.col);
  }
});

// ── Select All (⌘A) ───────────────────────────────
/** ⌘A・Edit メニューの Select All に共通の「付箋全体を選択する」処理。画像選択中ならそれも
 * 解除したうえで、描画 DOM 上に付箋の内容全体の Range を張る。空の付箋（内容が空 1 行のみ）は
 * プレースホルダしか無く選択対象が無いので何もしない。 */
function selectAllNote() {
  clearImageSelection();
  const lines = getLines();
  if (lines.length === 1 && lines[0] === '') return;
  const range = document.createRange();
  range.selectNodeContents(mdView);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

document.addEventListener('keydown', (e) => {
  if (composing) return;
  if (!(e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a')) return;
  if (e.defaultPrevented) return;
  e.preventDefault();
  selectAllNote();
});

// 行またぎ選択の Escape はブラウザ既定に無いので自前で解除する。mdView がフォーカスを
// 持ったまま selection だけを空にすると、フォーカスされた contenteditable には常にキャレットが
// 要るというブラウザの既定動作で collapsed な selection が即座に再生成されてしまう。
// blur まで行い、キャレットが立たない見た目にする
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  if (!mdView.contains(sel.getRangeAt(0).commonAncestorContainer)) return;
  e.preventDefault();
  sel.removeAllRanges();
  mdView.blur();
});

// ── Selection → 生 Markdown の写像 ─────────────────
// 描画部分（markdown-view）の選択から、対応する生 Markdown の範囲を求める。beforeinput の
// insertText/deleteContent・通常コピー（text/html + text/plain）・「Markdown をコピー」
// （右クリックメニュー）・⌘X がこの写像を共有する。

/** .md-ordered 行だけが持つ、自動採番の表示専用プレフィックス（"1. " 等）の文字数。
 * 他の行はマーカー（"- " 等）が inlineMarkdown に渡らず DOM に一切現れないため 0。 */
function orderedDisplayPrefixLength(lineEl) {
  const span = lineEl.querySelector(':scope > .md-order-num');
  return span ? span.textContent.length + 1 : 0; // + 直後の区切りスペース
}

/** lineEl の可視テキスト先頭から (node, offset) までの文字数。node は lineEl 自身か
 * その子孫である前提（呼び出し元が closest('[data-line]') で特定した後に渡す）。 */
function visibleOffsetInLine(lineEl, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(lineEl);
  range.setEnd(node, offset);
  return range.toString().length;
}

/**
 * 選択の一端（node, offset）が指す位置を、文書全体での (行番号, raw 列オフセット) に変換する。
 * isEnd は選択の終了端かどうか（装飾記法の内部に境界が落ちたときの丸め方向に使う。
 * visibleOffsetToRawOffset 参照）。対応する行が見つからなければ null。
 */
function resolveSelectionPoint(node, offset, isEnd) {
  let target = node;
  let targetOffset = offset;
  let el = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
  let block = el ? el.closest('[data-line]') : null;
  if (!block && target.nodeType === Node.ELEMENT_NODE && target.children.length > 0) {
    // 選択端点が mdView 自身のようなコンテナを指している場合（offset は子要素インデックス）、
    // 対応する子要素へ踏み込んで解決し直す。コンテナ末尾を指すオフセットは最後の子の末尾へ、
    // それ以外はその子の先頭へ丸める
    const container = target;
    const atEnd = targetOffset >= container.children.length;
    const child = container.children[atEnd ? container.children.length - 1 : targetOffset];
    target = child;
    targetOffset = atEnd ? child.childNodes.length : 0;
    el = target;
    block = el.closest('[data-line]');
  }
  if (!block) return null;

  const line = Number(block.dataset.line);
  const visible = visibleOffsetInLine(block, target, targetOffset);

  if (block.matches('.md-codeblock')) {
    // コードブロック: 可視テキストはフェンス内側の raw 行そのまま（改行で連結）なので、
    // 可視オフセットから行・列を直接計算する。renderMarkdown の data-line-end は、閉じた
    // フェンスでは「閉じフェンス行自身」（内容行はその手前まで）を指すが、未クローズ（EOF まで
    // フェンスが閉じない）だと「最後の内容行自身」を指す（閉じフェンス行が存在しないため）。
    // この違いを lines[lineEnd] が閉じフェンス行の形かどうかで判別し、内容行の終端をずらす
    const lineEnd = Number(block.dataset.lineEnd);
    const lines = getLines();
    const closed = lineEnd > line && /^```\s*$/.test(lines[lineEnd] ?? '');
    const lastContentLine = closed ? lineEnd - 1 : lineEnd;
    if (lastContentLine < line + 1) {
      // 内容行が 1 行も無い退化ケース（例: 閉じないまま "```" だけで EOF）。フェンス行自身へ逃がす
      return { line, col: lines[line].length };
    }
    let remaining = visible;
    for (let l = line + 1; l <= lastContentLine; l++) {
      const text = lines[l];
      if (l === lastContentLine || remaining <= text.length) {
        return { line: l, col: Math.min(remaining, text.length) };
      }
      remaining -= text.length + 1; // + 行間の改行
    }
  }

  const lineText = getLines()[line];
  const markerLen = markerLength(lineText);
  const inlineRaw = lineText.slice(markerLen);
  const prefixLen = orderedDisplayPrefixLength(block);
  const contentVisible = Math.max(0, visible - prefixLen);
  const rawOffset = markerLen + visibleOffsetToRawOffset(inlineRaw, contentVisible, isEnd, revealRangeForLine(line));
  return { line, col: rawOffset };
}

/** コードブロックの行範囲（開始行〜終了行、フェンス行含む）を [start, end] のペア配列で返す。
 * renderMarkdown が付ける data-line/data-line-end を DOM から読む。 */
function codeBlockLineRanges() {
  return Array.from(mdView.querySelectorAll('[data-line-end]'))
    .map((el) => [Number(el.dataset.line), Number(el.dataset.lineEnd)]);
}

function isCodeBlockLine(ranges, l) {
  return ranges.some(([s, e]) => l >= s && l <= e);
}

/** [openLine, dataLineEnd] から実際のフェンス情報を組み立てる。closed は data-line-end が
 * 閉じフェンス行自身を指しているか（true）、内容行自身を指しているか（false・未クローズ）。
 * resolveSelectionPoint のコードブロック分岐と同じ判定式。 */
function codeBlockFenceInfo(lines, openLine, dataLineEnd) {
  const closed = dataLineEnd > openLine && /^```\s*$/.test(lines[dataLineEnd] ?? '');
  return {
    closed,
    openLine,
    closeLine: closed ? dataLineEnd : null,
    firstContentLine: openLine + 1,
    lastContentLine: closed ? dataLineEnd - 1 : dataLineEnd,
  };
}

/**
 * コードブロックの可視テキストはフェンス内側の内容行だけなので、選択が内容行の全体（先頭〜末尾）
 * にちょうど一致していても、開き・閉じフェンス行自体は行範囲に含まれない。これは非対称になりやすい
 * （選択がブロックより上から始まれば開きフェンスは自然に含まれるが、内容の末尾ちょうどで終わる
 * 選択では閉じフェンス行が範囲外に落ちる）。ここでは「内容行の先頭から選択が始まっていれば
 * 開きフェンスも、内容行の末尾で選択が終わっていれば閉じフェンスも含める」よう両端を対称に拡張し、
 * 「ブロックの可視テキスト全体を選択したらフェンス込みで丸ごと取れる」形に揃える。
 * 未クローズのブロック（閉じフェンスが無い）、内容行が 1 行も無い空フェンス（別途
 * expandZeroVisibleLineSelection が処理する退化ケース）は対象外。
 */
function expandCodeBlockFences(start, end, lines, codeBlockRanges) {
  let newStart = start;
  let newEnd = end;
  for (const [openLine, dataLineEnd] of codeBlockRanges) {
    const info = codeBlockFenceInfo(lines, openLine, dataLineEnd);
    if (!info.closed || info.firstContentLine > info.lastContentLine) continue;
    // 開始・終了それぞれが「そのブロックを覆っているか」を独立に見るだけでは、内容行の
    // 一部（例: 複数行あるうちの 1 行だけ）を先頭〜末尾で選択したときに、片方の条件だけが
    // 偶然成立してフェンスが片側にだけ付いてしまう（例: "```js\nline1" のような未クローズの
    // 断片ができ、貼り戻すと以降の行までコードブロック化する）。両端が揃ってブロック全体を
    // 覆っているときだけ拡張する
    const startCovers = start.line < info.openLine
      || (start.line === info.firstContentLine && start.col === 0);
    const endCovers = end.line > info.closeLine
      || (end.line === info.lastContentLine && end.col === lines[end.line].length);
    if (!startCovers || !endCovers) continue;
    if (start.line === info.firstContentLine && start.col === 0) {
      newStart = { line: info.openLine, col: 0 };
    }
    if (end.line === info.lastContentLine && end.col === lines[end.line].length) {
      newEnd = { line: info.closeLine, col: lines[info.closeLine].length };
    }
  }
  return { start: newStart, end: newEnd };
}

/**
 * hr（<hr> は子ノードを持たない）や内容行の無い空フェンス（<code> が空）は、その行に可視の
 * テキストノードが 1 つも無い。resolveSelectionPoint は選択の開始・終了をテキストノード基準で
 * 区別するため、その行だけを選択しても start/end が同じ点に潰れてしまう。この行だけを選択した
 * 結果 start===end になっているときは、行（コードブロックなら開始行〜終了行）をまるごと採ることで
 * この退化を吸収する。resolveSelectionRange・buildPlainFromSelection の両方が
 * resolveSelectionBounds を経由するよう、ここで一元化する。
 */
function expandZeroVisibleLineSelection(start, end, lines) {
  if (start.line !== end.line || start.col !== end.col) return { start, end };
  const row = mdView.querySelector(`[data-line="${start.line}"]`);
  if (row && row.classList.contains('md-hr')) {
    return { start: { line: start.line, col: 0 }, end: { line: start.line, col: lines[start.line].length } };
  }
  if (row && row.tagName === 'PRE' && row.hasAttribute('data-line-end')) {
    const code = row.querySelector('code');
    if (!code || code.textContent.length === 0) {
      const lineEndIdx = Number(row.dataset.lineEnd);
      return { start: { line: start.line, col: 0 }, end: { line: lineEndIdx, col: lines[lineEndIdx].length } };
    }
  }
  return { start, end };
}

/**
 * DOM Range（markdown-view 内の選択）を生 Markdown 上の (行, 列) の開始・終了点へ解決する。
 * resolveSelectionRange（Markdown をコピー）と buildPlainFromSelection（通常コピーの
 * text/plain）が同じ行範囲・境界を共有するための土台。解決できなければ null。
 */
function resolveSelectionBounds(range) {
  const start = resolveSelectionPoint(range.startContainer, range.startOffset, false);
  const end = resolveSelectionPoint(range.endContainer, range.endOffset, true);
  if (!start || !end) return null;
  const lines = getLines();
  const codeBlockRanges = codeBlockLineRanges();

  // 開始行の可視オフセットが 0（= マーカー直後）なら、行頭（インデント・マーカー含む）から取る。
  // コードブロック行を対象外にする理由は下の終了端と同じ（適用すると選択していない行頭の
  // 生テキストまで巻き込む）
  if (!isCodeBlockLine(codeBlockRanges, start.line) && start.col === markerLength(lines[start.line])) {
    start.col = 0;
  }
  // 終了端が「次の行の可視オフセット 0」（＝その行のマーカー直後、内容は 1 文字も選択されて
  // いない）に落ちている場合、終了端をその行の行頭（col 0）まで切り詰める。行頭からドラッグして
  // 次の行の先頭で止める典型操作でここに落ちるが、切り詰めないとその行のマーカー（`> ` や
  // `- [ ] ` 等）だけが選択に含まれてしまう（内容が 0 文字なのにマーカーだけ拾う不整合）。
  // ただしコードブロック行には「マーカー相当の接頭辞」という概念が無く、行頭からの生テキストが
  // そのまま可視テキストなので、この切り詰めを適用すると選択済みの文字を落としてしまう
  // （例: `  - li` というコード行の可視オフセット 0 は raw の col 0 そのもの）。終了行が
  // コードブロック行のときは対象外にする
  if (
    end.line > start.line
    && !isCodeBlockLine(codeBlockRanges, end.line)
    && end.col === markerLength(lines[end.line])
  ) {
    end.col = 0;
  }

  const fenceExpanded = expandCodeBlockFences(start, end, lines, codeBlockRanges);
  return expandZeroVisibleLineSelection(fenceExpanded.start, fenceExpanded.end, lines);
}

// ── Raw → DOM 位置の写像（resolveSelectionPoint の逆） ────

/** 行 line の raw 列 col を、行頭マーカーを除いた「内容可視列」（inlineSegments 基準の
 * 可視文字オフセット）へ変換する。visibleOffsetFromRawOffset（note-lines.js）の DOM 版。
 * line がインライン生表示中（revealState）なら、その分も考慮して現在の DOM と対応させる。 */
function contentVisibleColumn(line, col) {
  const lineText = getLines()[line] ?? '';
  const markerLen = markerLength(lineText);
  const inlineRaw = lineText.slice(markerLen);
  const rawInInline = Math.max(0, Math.min(col, lineText.length) - markerLen);
  return visibleOffsetFromRawOffset(inlineRaw, rawInInline, revealRangeForLine(line));
}

/** 描画済みブロック blockEl 上で、「内容可視列」contentVisible に対応する DOM 位置
 * （テキストノード, オフセット）を返す。番号つきリストの連番プレフィックス分は
 * ここで足し込むので、呼び出し側は意識しなくてよい。ブロック内にテキストノードが
 * 無ければ（空行等）ブロック自身の先頭を返す。 */
function domPointForContentVisible(blockEl, contentVisible) {
  const prefixLen = orderedDisplayPrefixLength(blockEl);
  const at = nodeAt(blockEl, prefixLen + Math.max(0, contentVisible));
  return at || { node: blockEl, offset: 0 };
}

/**
 * 生 Markdown の (line, col) を、描画 DOM 上の (node, offset) へ写像する
 * （resolveSelectionPoint の逆）。マーカー・装飾記法の内部に col が落ちる場合は
 * visibleOffsetFromRawOffset の丸め規則に従って可視側の近い境界へ寄せる。
 * 行が描画されていなければ（未レンダー等）null。
 *
 * コードブロックのフェンス行（開き・閉じ）には対応する可視テキストが無いため、
 * 開きフェンス行は内容の先頭へ、閉じフェンス行は内容の末尾へ寄せる。
 */
function domPointForRawPosition(line, col) {
  const block = findBlock(line);
  if (!block) return null;
  const { el, start, end } = block;
  if (el.matches('.md-codeblock')) {
    const lines = getLines();
    let visible = 0;
    if (line <= start) {
      visible = 0; // 開きフェンス行 → 内容の先頭
    } else if (line >= end) {
      for (let l = start + 1; l < end; l++) visible += (lines[l]?.length ?? 0) + 1;
      visible = Math.max(0, visible - 1); // 閉じフェンス行 → 内容の末尾（最後の改行分を戻す）
    } else {
      for (let l = start + 1; l < line; l++) visible += (lines[l]?.length ?? 0) + 1; // + 行間の改行
      visible += Math.min(Math.max(col, 0), (lines[line] ?? '').length);
    }
    const at = nodeAt(el, visible);
    return at || { node: el, offset: 0 };
  }
  return domPointForContentVisible(el, contentVisibleColumn(line, col));
}

/** raw 位置 (startLine, startCol) 〜 (endLine, endCol) を、描画済み DOM 上の選択として張り直す
 * （domPointForRawPosition の Range 版）。indentLines が複数行選択への Tab 連打で選択を保ち続ける
 * のに使う。どちらかの端が解決できなければ何もしない。 */
function selectRawRange(startLine, startCol, endLine, endCol) {
  const start = domPointForRawPosition(startLine, startCol);
  const end = domPointForRawPosition(endLine, endCol);
  if (!start || !end) return;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// ── インライン生表示（reveal） ─────────────────────────
// キャレット（collapsed）が装飾（太字/斜字/取り消し線/インラインコード/リンク）の中・境界にある
// あいだ、その要素だけ生マーカー付きで表示する（`**bold**` がそのまま見える）。離れたら隠す。
// 表示だけの状態で rawContent・undo・保存には一切影響しない。selectionchange を駆動源にし、
// キャレット位置から reveal 対象を毎回再計算する。前回と同じなら再描画しない（ちらつき防止）。
//
// 不変条件: 選択（Selection）が非 collapsed の間、revealState は必ず null。装飾をまたぐ選択の
// 可視テキストは常に装飾適用後の表示（inlineVisibleSlice・buildPlainFromSelection が前提にする
// 表現）と一致させる必要があり、生 raw 表示（reveal）と非 collapsed 選択を同時に成立させない。

/** line 行に適用中の reveal 範囲（マーカーを除いた内容上の raw オフセット）。無ければ null。 */
function revealRangeForLine(line) {
  return revealState && revealState.line === line ? { start: revealState.start, end: revealState.end } : null;
}

function sameReveal(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.line === b.line && a.start === b.start && a.end === b.end;
}

/** line がコードブロックのフェンス行・内容行のどれかに含まれるか。findBlock（描画済み DOM 基準）
 * とは違い lines 配列だけから求める（scanFenceRanges は renderMarkdown 自身が使う判定とも共有）。
 * applyLines がまだ renderAll する前に reveal 対象を決めたいときに使う（DOM 依存だと直前の
 * 描画＝編集前の内容を見てしまう）。 */
function isFenceLine(lines, line) {
  for (const [open, { end }] of scanFenceRanges(lines)) {
    if (line >= open && line <= end) return true;
  }
  return false;
}

/** キャレット位置（line, raw 列 col）から reveal 対象を決める。ブロックマーカーの内部・
 * コードブロック・画像のみの行（キャレットを持たない）は対象外。lines 配列と markerLength だけから
 * 求まる（DOM に依存しない）ため、renderAll 前でも呼べる。 */
function computeRevealTarget(line, col) {
  const lines = getLines();
  const lineText = lines[line] ?? '';
  const markerLen = markerLength(lineText);
  if (col < markerLen) return null;
  if (isFenceLine(lines, line)) return null; // コードブロックは対象外
  if (isImageOnlyLine(lineText)) return null;
  const inlineRaw = lineText.slice(markerLen);
  const target = revealTargetAt(inlineRaw, col - markerLen);
  return target ? { line, start: target.start, end: target.end } : null;
}

/**
 * 選択が collapsed から非 collapsed に変わった瞬間（reveal 中の Shift+矢印での選択開始・
 * ドラッグ選択・⌘A 等）に、revealState を解除しつつ renderAll() で失われる DOM 選択を張り直す。
 * anchor/focus（後方への選択も含む向き）を resolveSelectionPoint で raw 位置へ解決してから
 * revealState を null にして再描画し、domPointForRawPosition で新しい（reveal を含まない）DOM 上の
 * 対応点へ選択を戻す。端点が装飾マーカーの内部（reveal 中しか到達できない raw 位置）に落ちていても、
 * domPointForRawPosition 自身の丸め規則（可視境界へのスナップ）でそのまま解決できる。端点を
 * 解決できない選択（mdView 外を含む Range 等）は復元を諦める。
 */
function restoreNonCollapsedSelectionAfterRevealClear(sel) {
  const range = sel.getRangeAt(0);
  const backward = sel.anchorNode !== range.startContainer || sel.anchorOffset !== range.startOffset;
  const startPoint = resolveSelectionPoint(range.startContainer, range.startOffset, false);
  const endPoint = resolveSelectionPoint(range.endContainer, range.endOffset, true);
  revealState = null;
  renderAll();
  if (!startPoint || !endPoint) return;
  const startDom = domPointForRawPosition(startPoint.line, startPoint.col);
  const endDom = domPointForRawPosition(endPoint.line, endPoint.col);
  if (!startDom || !endDom) return;
  const anchorDom = backward ? endDom : startDom;
  const focusDom = backward ? startDom : endDom;
  sel.setBaseAndExtent(anchorDom.node, anchorDom.offset, focusDom.node, focusDom.offset);
}

// mdView への collapsed キャレット移動はすべてネイティブ（クリック・矢印キー等）に任せているため、
// selectionchange だけが「キャレットが今どこにあるか」を検知できる唯一の経路になる。IME 変換中
// （composing）は切り替えない。
document.addEventListener('selectionchange', () => {
  if (composing) return;
  const sel = window.getSelection();
  const range = sel.rangeCount ? sel.getRangeAt(0) : null;
  const inMdView = !!range && mdView.contains(range.commonAncestorContainer);

  if (inMdView && !sel.isCollapsed) {
    // 選択が mdView 内で非 collapsed になった瞬間。revealState は必ず null にする（不変条件）が、
    // 選択そのものは restoreNonCollapsedSelectionAfterRevealClear が raw 位置経由で張り直す
    if (revealState) restoreNonCollapsedSelectionAfterRevealClear(sel);
    return;
  }
  if (!inMdView) {
    // 選択が mdView の外にある（mdView 外の選択変化で誤って reveal を組み立てないためのガードも兼ねる）
    if (revealState) {
      revealState = null;
      renderAll();
    }
    return;
  }

  // 現在の DOM（＝現在の revealState）を基準にキャレットの raw 位置を求めてから、
  // その raw 位置に対する新しい reveal 対象を決める
  const point = resolveSelectionPoint(range.startContainer, range.startOffset, false);
  const next = point ? computeRevealTarget(point.line, point.col) : null;
  if (sameReveal(next, revealState)) return;
  revealState = next;
  renderAll();
  // 再描画で失われたキャレットを、可視幅が変わった後の DOM でも同じソース位置へ復元する
  if (point) placeCaretAtRaw(point.line, point.col);
});

// mdView がフォーカスを失うとキャレットは表示されなくなるため、reveal も表示する意味が無い。
// IME 変換中（composing）の blur は、renderAll() が変換中の WebKit ネイティブ書き込み DOM ごと
// 差し替えてしまうため介入しない（compositionend が来るまで待つ）
mdView.addEventListener('blur', () => {
  if (composing) return;
  if (!revealState) return;
  revealState = null;
  renderAll();
});

/**
 * DOM Range（markdown-view 内の選択）から、対応する生 Markdown 文字列を組み立てる。
 * 解決できなければ null。
 */
function resolveSelectionRange(range) {
  const bounds = resolveSelectionBounds(range);
  if (!bounds) return null;
  const { start, end } = bounds;
  const lines = getLines();
  if (start.line === end.line) return lines[start.line].slice(start.col, end.col);
  const parts = [lines[start.line].slice(start.col)];
  for (let l = start.line + 1; l < end.line; l++) parts.push(lines[l]);
  parts.push(lines[end.line].slice(0, end.col));
  return parts.join('\n');
}

/** src の拡張子（小文字）を返す。クエリ・フラグメントは無視する。読み取れなければ null。 */
function imageExt(src) {
  if (!src) return null;
  const m = src.split(/[?#]/)[0].match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 通常コピー（text/html・text/plain）で画像の代わりに載せる表示ラベルを alt・src から組み立てる。
 * 生 Markdown の画像記法（`![alt](path)`）は UUID パス等が外部で意味を持たないため出さず、
 * 常に「(〜)」の平文にする。alt があってもそのままでは無く拡張子付きにするのは、貼り付け先で
 * 画像 1 枚ぶんだと分かるようにするため（例: alt「サンプル画像」+ .png → "(サンプル画像.png)"）。
 *   - alt 非空・拡張子あり: "(alt.ext)"
 *   - alt 非空・拡張子なし: "(alt)"
 *   - alt 空・拡張子あり: i18n imageAltFallbackWithExt（例: "(画像.png)"）
 *   - alt 空・拡張子なし: i18n imageAltFallback（例: "(画像)"）
 * window.I18N を読み込まない場面・テスト環境でも壊れないよう、無ければ日本語のフォールバックを
 * 返す（他の画像文言と同じパターン）。「Markdown をコピー」は生記法のままなのでここは使わない。
 */
function imageDisplayLabel(alt, src) {
  const ext = imageExt(src);
  if (alt) return ext ? `(${alt}.${ext})` : `(${alt})`;
  const hasI18n = typeof window !== 'undefined' && window.I18N;
  if (!ext) return hasI18n ? window.I18N.t('imageAltFallback') : '(画像)';
  const template = hasI18n ? window.I18N.t('imageAltFallbackWithExt') : '(画像.{ext})';
  return template.replace('{ext}', ext);
}

// 画像記法（![alt](src)）を raw 文字列中から検索する（非 global・先頭アンカーなし）。
// リンクや装飾に包まれた画像（`[![alt](p)](url)` / `**![a](p)**` 等）はセグメント合併で
// 1 つの装飾セグメントにまとまり、raw が画像記法だけでは終わらないため、完全一致ではなく検索で拾う
const IMAGE_MARKDOWN_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/;

/**
 * インライン部分の raw 文字列から [localStart, localEnd) の範囲だけを、装飾記法を可視テキストへ
 * 置換した文字列として取り出す。charMap を持つ装飾セグメントは中身の raw 範囲との重なりを
 * 可視文字単位で切り出す（境界が装飾の内部に落ちても「コピーされる範囲 = 削除される範囲」を保つ）。
 * charMap が無いセグメント（ネスト装飾等）は重なっていれば全体を含める。
 * 画像は inlineSegments の visibleText がタグの中身（＝属性である alt）を拾えないため常に空になる。
 * リンク・装飾に包まれた画像も同様に visibleText が空になる（stripTagsQuoteAware が <img> ごと
 * 中身の無いタグとして扱うため）ので、raw に完全一致するかではなく「visibleText が空かつ html に
 * <img を含む」ことで画像セグメントと判定し、raw から画像記法を検索して alt を取り出す。
 */
function inlineVisibleSlice(inlineRaw, localStart, localEnd) {
  if (localStart >= localEnd) return '';
  const segments = inlineSegments(inlineRaw);
  let out = '';
  for (const seg of segments) {
    const segStart = Math.max(seg.srcStart, localStart);
    const segEnd = Math.min(seg.srcEnd, localEnd);
    if (segStart >= segEnd) continue;
    const raw = inlineRaw.slice(seg.srcStart, seg.srcEnd);
    if (raw === seg.visibleText) {
      out += inlineRaw.slice(segStart, segEnd); // 装飾なしの素のテキスト。raw==visible なのでそのまま
      continue;
    }
    if (seg.charMap) {
      const cs = seg.charMap.srcStart;
      const from = Math.max(0, segStart - cs);
      const to = Math.min(seg.charMap.len, segEnd - cs);
      if (to > from) out += seg.visibleText.slice(from, to);
      continue;
    }
    if (seg.visibleText === '' && /<img\b/i.test(seg.html)) {
      const imgMatch = raw.match(IMAGE_MARKDOWN_RE);
      const { alt } = parseImageAlt(imgMatch ? imgMatch[1] : '');
      out += imageDisplayLabel(alt, imgMatch ? imgMatch[2] : '');
    } else {
      out += seg.visibleText;
    }
  }
  return out;
}

/**
 * 通常コピーの text/plain。生 Markdown の行構造（インデント・リスト記号・チェックボックス
 * 記法・コードフェンス・--- ・> ・# 見出しマーカー）はそのまま残し、インライン装飾（**太字** 等）
 * だけを可視テキストへ置換する。resolveSelectionBounds を共有するため、「Markdown をコピー」
 * （resolveSelectionRange）と行範囲・境界の丸めが一致する。
 * @param bounds resolveSelectionBounds(range) の結果（呼び出し元と共有し二重に解決しない）。
 *   null なら空文字を返す。
 */
function buildPlainFromSelection(range, bounds) {
  if (!bounds) return '';
  const { start, end } = bounds;
  const lines = getLines();
  // コードブロックの内容（フェンス行含む）は markdown 記法として解釈しない。renderMarkdown が
  // 付ける data-line/data-line-end の範囲を DOM から読み、その行はインライン装飾の置換を
  // 一切行わず raw のまま返す
  const codeBlockRanges = codeBlockLineRanges();

  const renderSlice = (lineIdx, colStart, colEnd) => {
    const lineText = lines[lineIdx];
    if (isCodeBlockLine(codeBlockRanges, lineIdx)) return lineText.slice(colStart, colEnd);
    const markerLen = markerLength(lineText);
    const markerPart = lineText.slice(Math.min(colStart, markerLen), Math.min(colEnd, markerLen));
    const inlineRaw = lineText.slice(markerLen);
    const localStart = Math.max(0, colStart - markerLen);
    const localEnd = Math.max(0, colEnd - markerLen);
    return markerPart + inlineVisibleSlice(inlineRaw, localStart, localEnd);
  };

  if (start.line === end.line) return renderSlice(start.line, start.col, end.col);
  const parts = [renderSlice(start.line, start.col, lines[start.line].length)];
  for (let l = start.line + 1; l < end.line; l++) parts.push(renderSlice(l, 0, lines[l].length));
  parts.push(renderSlice(end.line, 0, end.col));
  return parts.join('\n');
}

// ── 通常コピーの text/html セマンティック変換 ──────────────────────
// 描画 DOM（.md-h1 等の CSS クラス）をそのまま text/html に載せると、貼り付け先
// （Google Docs / Notion / Slack / Word / 別の付箋）は独自クラスに意味を持たないため
// 見出し・リスト・コードブロックの構造が失われる。行要素の並びを見出し・リスト・
// 引用・コードブロックのセマンティック HTML（h1〜h3 / ul・ol / blockquote / pre）へ
// 変換してから text/html に載せる。htmlToMarkdown（リッチテキストペースト変換）が
// 読める形に合わせてあり、別の付箋へ貼り戻すと構造が概ね復元される。

/** 行要素のクラスから、変換で使う種別を判定する。markdown.js の renderMarkdown の
 * 分岐と対応させている。 */
function lineElementKind(row) {
  if (row.tagName === 'PRE') return 'codeblock';
  if (row.classList.contains('md-h1')) return 'h1';
  if (row.classList.contains('md-h2')) return 'h2';
  if (row.classList.contains('md-h3')) return 'h3';
  if (row.classList.contains('md-check')) return 'check';
  if (row.classList.contains('md-ordered')) return 'ordered';
  if (row.classList.contains('md-bullet')) return 'bullet';
  if (row.classList.contains('md-blockquote')) return 'blockquote';
  if (row.classList.contains('md-hr')) return 'hr';
  if (row.classList.contains('md-empty')) return 'empty';
  return 'line'; // .md-line（無印の行）
}

/** md-indent-N クラスからインデントレベルを読む（無ければ 0）。 */
function lineElementIndentLevel(row) {
  const m = Array.from(row.classList).find((c) => /^md-indent-\d$/.test(c));
  return m ? Number(m.slice('md-indent-'.length)) : 0;
}

/** class・data-* 属性と <input>（チェックボックスの入力要素。可視テキストを持たない）を
 * すべて落とす（アプリ内部の状態で、貼り付け先には意味を持たないため）。
 * <a> は data-url を落とすだけで href はそのまま残す。 */
function stripInternalAttrs(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('input').forEach((el) => el.remove());
  div.querySelectorAll('*').forEach((el) => {
    el.removeAttribute('class');
    Array.from(el.attributes).forEach((attr) => {
      if (attr.name.startsWith('data-')) el.removeAttribute(attr.name);
    });
  });
  return div.innerHTML;
}

/** リスト系の行種別（bullet/ordered/check）かどうか。連続グループ化・ツリー構築で
 * 「リスト行かどうか」を種別混在のまま束ねるために使う。 */
function isListKind(kind) {
  return kind === 'bullet' || kind === 'ordered' || kind === 'check';
}

/**
 * 1 つのリスト項目行（bullet/ordered/check）から <li> の中身を取り出す。
 * ordered は自動採番の表示専用プレフィックス（.md-order-num）を、check は
 * <input> を、それぞれ構造から除いて内容だけにする。
 * ordered の表示番号はクローン（選択範囲によっては .md-order-num が欠けている）ではなく、
 * mdView 上の元の行要素から読む（fix: 番号スパンより後ろから選択しても正しい番号を拾う）。
 */
function extractListItemContent(kind, row) {
  if (kind === 'check') {
    const input = row.querySelector('input');
    const checked = !!(input && input.checked);
    const span = row.querySelector('span');
    // to-do ブロックとして解釈するペースト先は無いため平文に落とすが、`[x] `/`[ ] ` の形にして
    // おくことで、貼り戻し先が別の付箋なら htmlToMarkdown 経由で本物のチェックボックスに戻る
    const html = (checked ? '[x] ' : '[ ] ') + (span ? stripInternalAttrs(span.innerHTML) : '');
    return { html };
  }
  if (kind === 'ordered') {
    const original = mdView.querySelector(`[data-line="${row.dataset.line}"]`) || row;
    const numSpan = original.querySelector('.md-order-num');
    const num = numSpan ? parseInt(numSpan.textContent, 10) || 1 : 1;
    const clone = row.cloneNode(true);
    clone.querySelector('.md-order-num')?.remove();
    // .md-order-num の直後にある区切りスペース 1 文字ぶんも一緒に落とす
    const html = stripInternalAttrs(clone.innerHTML.replace(/^ /, ''));
    return { html, num };
  }
  return { html: stripInternalAttrs(row.innerHTML) }; // bullet
}

/** フラットな { level, kind, html, num } の並びを、level の差にもとづく親子ツリーへ組み立てる。
 * kind は各ノードが自分の <ul>/<ol> をどちらで開くかの判断に使う（bullet/ordered/check が
 * 混在した入れ子でも、ノードごとに正しいタグへ振り分けられるようにするため）。 */
function buildListTree(items) {
  const base = Math.min(...items.map((it) => it.level));
  const root = { level: base - 1, children: [] };
  const stack = [root];
  for (const item of items) {
    while (stack.length > 1 && stack[stack.length - 1].level >= item.level) stack.pop();
    const node = { level: item.level, kind: item.kind, html: item.html, num: item.num, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

/** ツリーの 1 階層ぶんを直列化する。同じ階層内でも種別（bullet/ordered/check）が変われば
 * <ul>/<ol> を区切り直す（check は <ul> 扱い）。ordered の各 <li> には元の行要素から読んだ
 * 表示番号を value として個別に付ける。renderMarkdown は番号行以外（bullet 等）が挟まると
 * カウンタをリセットするため、入れ子を挟んだ番号リストは画面上「1 / 1 / 2」のように連番が
 * 途中でリセットされることがあるが、種別混在でも 1 つの <ol> にまとめる都合上ブラウザの
 * 既定の自動採番（1 / 2 / 3）に任せると食い違う。<li value> で個々の番号を明示することで
 * 貼り付け先の採番を画面表示・text/plain と一致させる */
function serializeListTree(nodes) {
  let out = '';
  let i = 0;
  while (i < nodes.length) {
    const kind = nodes[i].kind;
    const tag = kind === 'ordered' ? 'ol' : 'ul';
    const startAttr = kind === 'ordered' ? ` start="${nodes[i].num}"` : '';
    out += `<${tag}${startAttr}>`;
    while (i < nodes.length && nodes[i].kind === kind) {
      const valueAttr = kind === 'ordered' ? ` value="${nodes[i].num}"` : '';
      out += `<li${valueAttr}>${nodes[i].html}`;
      if (nodes[i].children.length) out += serializeListTree(nodes[i].children);
      out += '</li>';
      i++;
    }
    out += `</${tag}>`;
  }
  return out;
}

/** 連続するリスト行（bullet/ordered/check が混在してよい）1 ブロックぶんを <ul>/<ol> の
 * 入れ子ツリーに組み立てる。種別の変わり目でリストが分断されないよう、レベル差による
 * 親子関係は種別をまたいで判定する。 */
function buildListHtml(rows) {
  const items = rows.map((row) => {
    const kind = lineElementKind(row);
    return { level: lineElementIndentLevel(row), kind, ...extractListItemContent(kind, row) };
  });
  return serializeListTree(buildListTree(items));
}

/**
 * トップレベルが行要素（mdView 直下の [data-line] 要素）の並びであるクローンを、
 * セマンティック HTML へ変換する。連続する同種の行（リスト・引用）はまとめて 1 ブロックにする。
 */
function rowsToSemanticHtml(rows) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    const kind = lineElementKind(row);
    if (kind === 'h1' || kind === 'h2' || kind === 'h3') {
      out.push(`<${kind}>${stripInternalAttrs(row.innerHTML)}</${kind}>`);
      i++;
    } else if (kind === 'hr') {
      out.push('<hr>');
      i++;
    } else if (kind === 'empty') {
      out.push('<p></p>');
      i++;
    } else if (kind === 'codeblock') {
      const code = row.querySelector('code');
      // Google Docs / Word 等は HTML ペーストでコードブロックの書式を持たないため、
      // 等幅フォントで見分けられるよう inline style を付ける
      out.push(`<pre style="font-family: monospace"><code>${code ? code.innerHTML : ''}</code></pre>`);
      i++;
    } else if (kind === 'blockquote') {
      const lines = [];
      while (i < rows.length && lineElementKind(rows[i]) === 'blockquote') {
        lines.push(`<p>${stripInternalAttrs(rows[i].innerHTML)}</p>`);
        i++;
      }
      out.push(`<blockquote>${lines.join('')}</blockquote>`);
    } else if (isListKind(kind)) {
      const group = [];
      while (i < rows.length && isListKind(lineElementKind(rows[i]))) {
        group.push(rows[i]);
        i++;
      }
      out.push(buildListHtml(group));
    } else {
      out.push(`<p>${stripInternalAttrs(row.innerHTML)}</p>`); // .md-line
      i++;
    }
  }
  return out.join('');
}

/**
 * range.cloneContents() から通常コピー用の text/html・text/plain を組み立てる。
 * img は元パスがアプリ外で解決できないため、html・plain どちらも alt テキストへ置き換える
 * （置換後の同じクローンを両方の生成元にする）。
 * 選択範囲が生 Markdown の (行, 列) へ解決できない場合は null を返す。この場合、呼び出し元は
 * 独自のコピー処理をせず既定のコピーに任せる（解決できない DOM の断片を html・plain にそのまま
 * 流し込まないため）。
 * @param bounds 呼び出し元が resolveSelectionBounds(range) を計算済みなら渡す（⌘X が削除範囲と
 *   共有するため）。省略時はここで計算する。
 */
function buildSelectionCopyPayload(range, bounds = resolveSelectionBounds(range)) {
  if (!bounds) return null;

  const container = document.createElement('div');
  container.appendChild(range.cloneContents());
  container.querySelectorAll('img').forEach((img) => {
    const alt = img.getAttribute('alt') || '';
    // data-rel-src は renderMarkdown が書いた raw の相対パス（resolveImageSrc 前）。
    // 拡張子の見た目を安定させるため、asset URL 化された src ではなくこちらを優先する
    const src = img.dataset.relSrc || img.getAttribute('src') || '';
    img.replaceWith(document.createTextNode(imageDisplayLabel(alt, src)));
  });

  // html: クローンのトップレベルに「行要素」（mdView 直下の要素の複製。常に <div data-line>
  // か <pre data-line>）が 1 つでもあれば、行の並びとしてセマンティック HTML へ変換する。
  // 複数行にまたがる選択はもちろん、選択が 1 行しか触れていなくても、その境界が
  // 「行の手前」のようなコンテナレベルの位置（mdView 直下の子オフセット）で表現されている
  // ときは、cloneContents がその行を属性ごとまるごと複製する（commonAncestorContainer が
  // mdView になり、行要素は「完全または部分的に範囲内にある mdView の子」として扱われるため）。
  // これは「行をまるごと選択する」典型的な操作（例: 行頭から次行の手前までドラッグ）で実際に
  // 起こる形。<input data-line>（チェックボックス）や .md-order-num の span も data-line
  // 相当の属性を持つことがあるが、それらは tagName が DIV/PRE ではないため区別できる
  const hasRowElement = Array.from(container.children).some(
    (el) => el.hasAttribute('data-line') && (el.tagName === 'DIV' || el.tagName === 'PRE'),
  );
  const html = hasRowElement
    ? rowsToSemanticHtml(Array.from(container.children))
    : stripInternalAttrs(container.innerHTML);

  // plain: DOM クローンではなく、選択範囲の (行, 列) を生 Markdown へ解決する
  // buildPlainFromSelection を使う（text/plain の仕様。行構造は raw のまま、インライン
  // 装飾だけ可視テキストへ置換する。詳細は同関数のコメント参照）
  const plain = buildPlainFromSelection(range, bounds);
  return { html, plain };
}

// 画像選択中の ⌘C/⌘X はネイティブ Edit メニューのショートカットとして処理される
// （keydown まで届かない）。selectImage が張った DOM 選択のおかげでメニュー項目が有効になり、
// メニュー経由の Copy/Cut が WebKit の copy/cut イベントとして DOM に届く。selectedImage が
// 無いとき（通常のテキスト選択）は preventDefault せず、ブラウザ既定のコピー/カットに任せる
document.addEventListener('copy', (e) => {
  if (selectedImage) {
    e.preventDefault();
    copySelectedImage();
    return;
  }
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return; // 選択なしは既定に任せる（何もしない）
  const range = sel.getRangeAt(0);
  if (!mdView.contains(range.commonAncestorContainer)) return;
  const payload = buildSelectionCopyPayload(range);
  if (!payload) return; // 生 Markdown へ解決できない選択（プレースホルダ等）は既定のコピーに任せる
  e.preventDefault();
  e.clipboardData.setData('text/html', payload.html);
  e.clipboardData.setData('text/plain', payload.plain);
});

/** start と end が resolveSelectionBounds 上で同一点に解決されたかどうか。hr・空フェンス等の
 * 「可視テキストが 1 つも無い行」は expandZeroVisibleLineSelection が先に行全体へ展開するため
 * ここには来ない（このチェックが捕まえるのは、それ以外の理由で退化した選択だけ）。 */
function boundsAreDegenerate(bounds) {
  return bounds.start.line === bounds.end.line && bounds.start.col === bounds.end.col;
}

/** 現在の DOM 選択を削除/置換向けに判定する（判定フェーズ、resolveSelectionBounds 経由で
 * 例外を投げうる）。解決できない選択・退化した選択（可視範囲が空）では null。行またぎに限らず、
 * 非空の単一行選択も対象にする（「コピーされる範囲 = 削除される範囲」という設計）。 */
function resolveDeletableBounds() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const bounds = resolveSelectionBounds(range);
  if (!bounds || boundsAreDegenerate(bounds)) return null;
  return bounds;
}

/** 行またぎ選択（生 Markdown の {start, end}）を insertedText で置き換える。start 行の手前と
 * end 行の続きの間へ insertedText を差し込む（改行を含めば複数行に展開される。空文字なら
 * 削除だけになる）。全体を空にすれば空 1 行になる。キャレットは insertedText の直後（raw 位置
 * としては、保存された装飾の閉じマーカーがあればその後ろになるが、マーカーは描画されないため
 * 可視位置としては insertedText の直後と一致する）に置く（applyLines が rawContent 更新 →
 * renderAll → placeCaretAtRaw → 保存の順で行う。削除と挿入をここで 1 回の applyLines に
 * まとめることで undo も 1 手にまとまる）。
 *
 * start 行の末尾側 [start.col, 行末または end.col) と end 行の先頭側 [0 または start.col, end.col)
 * は、削除する前に widenRangeForEmptiedDecorations で「内容が空になる装飾」のマーカーごと含める
 * よう広げ、続けて deletionSurvivingFragment で「部分的に覆われた装飾」のマーカーを保存する
 * （装飾はマーカーと内容が不可分な 1 つの記法なので、内容の一部だけを削除してマーカーの片方だけ
 * 残すと記法が壊れる）。装飾は行をまたがないため、
 * この処理は start 行・end 行それぞれで独立に閉じる（中間の行は丸ごと削除されるだけ）。
 *
 * revealRangeForLine を deletionSurvivingFragment（マーカー保存の判定）へ渡すのは、インライン
 * 生表示中はマーカー自体が可視の生テキストであり、その直接削除・置換（装飾解除）を部分選択の
 * マーカー保存と混同しないため（reveal 中のセグメントは charMap が raw 全体を指すので、保存
 * 対象から自然に外れる）。widenRangeForEmptiedDecorations（空マーカー正規化）へは渡さない：
 * 内容の 1 文字削除もほぼ常に reveal 中に起きるため、reveal を
 * 渡すと正規化そのものが働かなくなる。lineStartColumn を明示的に渡すのは、フェンス内容行の
 * 行頭空白を markerLength がインデントと誤認しないようにするため（lineStartColumn は 0 を返す）。 */
function spliceSelectionRange(bounds, insertedText) {
  const { start, end } = bounds;
  const lines = getLines();
  const sameLine = start.line === end.line;

  const startMarkerLen = lineStartColumn(start.line);
  const tailHi = sameLine ? end.col : lines[start.line].length;
  const startReveal = revealRangeForLine(start.line);
  const tailRange = widenRangeForEmptiedDecorations(lines[start.line], start.col, tailHi, startMarkerLen);
  const tail = deletionSurvivingFragment(lines[start.line], tailRange.lo, tailRange.hi, startMarkerLen, startReveal);

  const endMarkerLen = sameLine ? startMarkerLen : lineStartColumn(end.line);
  const endReveal = sameLine ? startReveal : revealRangeForLine(end.line);
  const headRange = sameLine ? tailRange : widenRangeForEmptiedDecorations(lines[end.line], 0, end.col, endMarkerLen);
  const headText = sameLine ? '' : deletionSurvivingFragment(lines[end.line], headRange.lo, headRange.hi, endMarkerLen, endReveal).text;

  const middle = tail.text.slice(0, tail.insertOffset) + insertedText + tail.text.slice(tail.insertOffset) + headText;

  const prefix = lines[start.line].slice(0, tailRange.lo);
  const suffix = lines[end.line].slice(sameLine ? tailRange.hi : headRange.hi);
  const parts = middle.split('\n');
  parts[0] = prefix + parts[0];
  const caretLine = start.line + parts.length - 1;
  const caretCol = parts[parts.length - 1].length;
  parts[parts.length - 1] += suffix;
  lines.splice(start.line, end.line - start.line + 1, ...parts);
  applyLines(lines, caretLine, caretCol);
}

/** bounds を実際に置き換える（変更フェーズ）。insertedText を省略すると削除だけになる
 * （Backspace/Delete/⌘X はこちら）。ここで投げた例外は rawContent と DOM が食い違ったまま
 * 止まる致命的なバグであり、判定フェーズの「解決できない選択は既定に委ねる」とは性質が
 * 違うため、呼び出し元は try で包まず伝播させる。 */
function commitSelectionReplacement(bounds, insertedText = '') {
  window.getSelection().removeAllRanges();
  // splice で行番号がずれる前に、stale な画像選択を解いておく。spliceSelectionRange の後だと
  // placeCaretAtRaw が張り直した新しい画像選択まで消してしまう
  clearImageSelection();
  spliceSelectionRange(bounds, insertedText);
}

/** 削除だけを行う commitSelectionReplacement のショートハンド。 */
function commitSelectionDeletion(bounds) {
  commitSelectionReplacement(bounds);
}

/** cut イベント側で実際に処理できる（mdView 内で解決でき、退化していない）ときの range と
 * bounds。keydown 側で「cut イベントに任せてよいか」を判定するのにも使う
 * （判定フェーズ、例外を投げうる）。 */
function resolveCutSelection() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!mdView.contains(range.commonAncestorContainer)) return null;
  const bounds = resolveSelectionBounds(range);
  if (!bounds || boundsAreDegenerate(bounds)) return null;
  return { range, bounds };
}

document.addEventListener('cut', (e) => {
  if (selectedImage) {
    e.preventDefault();
    cutSelectedImage();
    return;
  }
  // markdown-view の描画テキスト上の ⌘X。行またぎに限らず、退化していない選択（可視範囲が
  // 空でない）ならすべて対象にする（コピーされる範囲 = 削除される範囲、という設計）。
  // copy と同じ payload をクリップボードへ載せたうえで、コピーとは違い選択範囲を実際に削除する
  // （copy イベントは選択を残すだけ）。判定フェーズ（resolveCutSelection）だけを try で保護する
  let resolved;
  try {
    resolved = resolveCutSelection();
  } catch (err) {
    console.error('cut guard failed:', err);
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (!resolved) {
    // 解決できない選択は、ネイティブ cut に任せると contenteditable の DOM だけが
    // 書き換わり rawContent との整合が崩れるため、常に止める
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const { range, bounds } = resolved;
  const payload = buildSelectionCopyPayload(range, bounds);
  if (!payload) return;
  e.preventDefault();
  e.clipboardData.setData('text/html', payload.html);
  e.clipboardData.setData('text/plain', payload.plain);
  // 変更フェーズ。クリップボードへ載せた後の例外は「載ったのに消えていない」という
  // 中途半端な状態を招く致命的なバグなので、握り潰さず伝播させる
  commitSelectionDeletion(bounds);
});

/** 非同期解決（クリップボード画像の保存・data: 画像を含む html の変換待ち）を挟むペーストの
 * 結果を反映する。待機の間に別の編集が入って rawContent が snapshot から変わっていた場合、
 * bounds の raw 位置はもう対応しないため、内容を失わないよう末尾へ追記する。lines 配列へ足して
 * applyLines へ流すことで、末尾行が閉じフェンス行だった場合の ensureTrailingLineAfterClosedFence
 * （そのまま連結すると閉じフェンスの記法が壊れる）と、reveal 対象の再計算が働く。 */
function applyResolvedPaste(bounds, snapshot, text) {
  if (rawContent === snapshot) {
    commitSelectionReplacement(bounds, text);
    return;
  }
  const lines = getLines();
  ensureTrailingLineAfterClosedFence(lines);
  const lastLine = lines.length - 1;
  const parts = text.split('\n');
  parts[0] = lines[lastLine] + parts[0];
  lines.splice(lastLine, 1, ...parts);
  applyLines(lines, lastLine + parts.length - 1, parts[parts.length - 1].length);
}

/** クリップボード画像ファイルを保存し、bounds（ペースト時点の caret/選択）へ画像記法 + 改行を
 * 挿入する。画像記法の直後で行を割ることで、貼った直後から生の記法ではなく画像として描画される。 */
async function pasteImageAtCaret(file, bounds) {
  const snapshot = rawContent;
  const relPath = await savePastedImage(file);
  if (!relPath) return;
  applyResolvedPaste(bounds, snapshot, `![](${relPath})\n`);
}

/**
 * paste イベントの内容を bounds（resolveEditableBounds の結果）へ合流させる。優先順位:
 * 1) 単一行選択 + プレーンテキストが裸 URL → `[選択テキスト](URL)` のリンク化
 *    （行またぎ選択は改行入りラベルで記法が壊れるため対象外、素の URL 挿入に落ちる。
 *    ラベルは sanitizeAltText で `]` を除去し、URL に `)` を含む場合はリンクの終端と
 *    衝突するためリンク化せず素の URL 挿入にフォールバックする）
 * 2) プレーンテキストが空でクリップボードに画像ファイルがある → save_pasted_image 経由で画像記法
 * 3) それ以外 → toMarkdown（リッチテキストなら Markdown 変換、そうでなければプレーンテキストのまま）
 */
function handlePaste(bounds, clipboardData) {
  const text = clipboardData.getData('text/plain');
  const label = bounds.start.line === bounds.end.line
    ? getLines()[bounds.start.line].slice(bounds.start.col, bounds.end.col)
    : '';
  const url = text.trim();
  if (label && /^https?:\/\/\S+$/.test(url) && !url.includes(')')) {
    commitSelectionReplacement(bounds, `[${sanitizeAltText(label)}](${url})`);
    return;
  }
  if (!text) {
    const imageItem = Array.from(clipboardData.items ?? [])
      .find(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (imageItem) {
      pasteImageAtCaret(imageItem.getAsFile(), bounds);
      return;
    }
  }
  const converted = toMarkdown(text, clipboardData.getData('text/html'));
  if (converted instanceof Promise) {
    const snapshot = rawContent;
    converted
      .then(md => applyResolvedPaste(bounds, snapshot, md))
      .catch(err => {
        console.error('paste conversion failed:', err);
        renderAll();
      });
    return;
  }
  commitSelectionReplacement(bounds, converted);
}

document.addEventListener('paste', (e) => {
  const bounds = resolveEditableBounds();
  if (!bounds) { e.preventDefault(); return; }
  e.preventDefault();
  handlePaste(bounds, e.clipboardData);
}, true);

// ── Image Selection: keyboard ──────────────────────
// 画像選択中は独立した contenteditable が無い（mdView 自体が contenteditable だが、選択中の
// img は contenteditable="false" でキャレットを持たない）ため、document レベルの keydown で拾う。
// selectedImage が無いときは即 return するので、色ドットの矢印キーナビゲーションや ⌘W 等、
// 他のキー処理とは衝突しない。
// 削除処理中の多重発火ガード（キーリピートでの確認ダイアログ多重表示・二重削除を防ぐ）
let deletingImage = false;

/**
 * 選択中の画像を取り除く共通処理。`cmd` は 'delete_image'（Backspace/Delete、
 * confirm_before_delete に従う）または 'cut_image'（⌘X、コピー成功後に確認なしで削除）。
 * どちらも Rust 側が新しい content（`Option<String>`）を返し、成功時はここで
 * rawContent に反映してキャレットを置く。`preferredLineAfter` は削除後のキャレット候補行
 * （行番号が無効なら末尾へフォールバックする）。
 */
async function removeSelectedImage(cmd, preferredLineAfter, failMessageKey) {
  // applyingHistory 中は undo/redo が rawContent を巻き戻している最中なので、
  // 確認ダイアログ・invoke 待ちの間に対象がすり替わらないよう避ける
  // （performUndo/performRedo 側も deletingImage を見て相互に避け合う）
  if (!selectedImage || deletingImage || applyingHistory) return;
  deletingImage = true;
  try {
    // 別行の未保存入力（デバウンス窓の中）が残っていると、Rust 側は古い content を基に
    // 削除後の内容を計算してしまい、その戻り値で rawContent を丸ごと置き換えるときに
    // 未保存分が黙って消える。削除対象を Rust に渡す前に必ず確定させる
    await flushContent();
    // flush の await 中に選択が変わった／消えた可能性を考慮し、ここで再確認する
    if (!selectedImage) return;
    const { line, occurrence, relSrc } = selectedImage;
    let newContent;
    try {
      newContent = await invoke(cmd, {
        id: noteId,
        imagePath: relSrc,
        imageLine: line,
        imageOccurrence: occurrence,
      });
    } catch (err) {
      console.error(`${cmd} failed:`, err);
      showToast(I18N.t(failMessageKey));
      return;
    }
    // キャンセル（confirm_before_delete で拒否）・対象が既に無い場合は選択を保ったまま何もしない
    if (newContent == null) return;
    clearImageSelection();
    rawContent = newContent;
    // saveNow を経由しない書き換えなので、ここで明示的に commit する（不変条件はコメント参照）
    editHistory?.commit(rawContent);
    renderAll();
    const lines = getLines();
    const preferred = preferredLineAfter(line);
    const target = (preferred >= 0 && preferred < lines.length) ? preferred : lines.length - 1;
    placeCaretAtRaw(target, null);
  } finally {
    deletingImage = false;
  }
}

function deleteSelectedImage(key) {
  // 削除後のキャレット位置: 来た方向（押されたキー）の逆側優先。Backspace は前の行
  // （前の行が無ければ先頭（0）に留まる（末尾へは飛ばさない）。Delete はそのまま同じ index
  // （消えた行の次が繰り上がってくる）。それも無ければ末尾へ
  const preferredLineAfter = (line) => key === 'Backspace' ? Math.max(0, line - 1) : line;
  return removeSelectedImage('delete_image', preferredLineAfter, 'toastDeleteImageFailed');
}

/** ⌘C。選択中の画像をクリップボードへコピーする。選択は維持する。 */
async function copySelectedImage() {
  if (!selectedImage) return;
  try {
    await invoke('copy_image', { imagePath: selectedImage.relSrc });
  } catch (err) {
    console.error('copy_image failed:', err);
    showToast(I18N.t('toastCopyImageFailed'));
  }
}

/**
 * ⌘X。選択中の画像をカット（コピー→削除）する。
 * キャレット配置は Backspace と同じ（前の行優先、先頭行なら先頭に留まる）。
 */
function cutSelectedImage() {
  return removeSelectedImage('cut_image', (line) => Math.max(0, line - 1), 'toastCutImageFailed');
}

/** selectedImage が指す画像に、現在の DOM 選択がまだ実際に張られているか。mdView 全体が
 * contenteditable になったことで、DOM 選択は（テストの直接操作や将来の拡張で）selectedImage を
 * 経由せず書き換えられうる。食い違ったまま Backspace/Delete 等をこのハンドラが横取りすると、
 * 実際にはテキスト側へ移った選択の編集操作を奪ってしまうため、ここで整合性を確認する。 */
function selectionStillCoversSelectedImage() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return false;
  const img = mdView.querySelector('img.img-selected');
  if (!img) return false;
  return sel.getRangeAt(0).intersectsNode(img);
}

/** 行 lineIdx が「画像のみの行」として選択状態になる対象かどうか（placeCaretAtRaw の
 * isStandalone 判定と同じ。フェンス内は画像として描画されないため対象外）。 */
function isStandaloneImageLine(lineIdx) {
  const block = findBlock(lineIdx);
  const isStandalone = !block || block.start === block.end;
  return isStandalone && isImageOnlyLine(getLines()[lineIdx] ?? '');
}

/** collapsed range のキャレット位置が、要素 el の折り返し込みの視覚行として先頭側
 * （edge === 'top'）/末尾側（edge === 'bottom'）に居るか。折り返しの無い行は常に true。
 * el 自身の getBoundingClientRect() は min-height 等の余白を含み実際のテキスト行と高さが
 * 一致しないため、el のテキスト全体を覆う Range の getClientRects()（折り返し 1 行につき 1
 * 矩形を返す）を基準にする。 */
function isCaretAtVisualEdge(range, el, edge) {
  const blockRange = document.createRange();
  blockRange.selectNodeContents(el);
  const lineRects = blockRange.getClientRects();
  if (lineRects.length <= 1) return true; // 折り返し無し（空行含む）
  const target = edge === 'top' ? lineRects[0] : lineRects[lineRects.length - 1];
  const caretRects = range.getClientRects();
  const caretRect = (edge === 'top' ? caretRects[0] : caretRects[caretRects.length - 1])
    || range.getBoundingClientRect();
  const mid = (caretRect.top + caretRect.bottom) / 2;
  return mid >= target.top && mid <= target.bottom;
}

// テキスト行から矢印キーで画像のみの行へ「入る」変換。img は contenteditable="false" で
// キャレットの着地点を持たないため、ネイティブな矢印移動は画像のみの行を素通りする
// （↓ で 1 行下ではなくその次のテキスト行まで飛ぶ等）。隣が画像のみの行のときだけ
// 選択状態（selectImage）へ変換して着地させる。選択中の画像から抜ける経路は既存の
// 「画像選択中」ハンドラ（このすぐ下）が対称に扱う。同じ keydown が両方の document
// リスナーへ届くため、変換したときは stopImmediatePropagation でもう片方の二重発火を防ぐ。
document.addEventListener('keydown', (e) => {
  if (composing || selectedImage) return;
  if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!mdView.contains(range.commonAncestorContainer)) return;
  const point = resolveSelectionPoint(range.startContainer, range.startOffset, false);
  if (!point) return;
  const lines = getLines();

  let target = null;
  if (e.key === 'ArrowDown') {
    // 折り返しがある行では、最後の視覚行に居るときだけ次の論理行への変換を試す
    // （途中の視覚行での ↓ はネイティブな折り返し内移動に任せる）
    const block = findBlock(point.line);
    if (block && isCaretAtVisualEdge(range, block.el, 'bottom')) target = point.line + 1;
  } else if (e.key === 'ArrowUp') {
    const block = findBlock(point.line);
    if (block && isCaretAtVisualEdge(range, block.el, 'top')) target = point.line - 1;
  } else if (e.key === 'ArrowRight' && point.col >= (lines[point.line]?.length ?? 0)) target = point.line + 1;
  else if (e.key === 'ArrowLeft' && point.col <= lineStartColumn(point.line)) target = point.line - 1;
  if (target == null || target < 0 || target >= lines.length || !isStandaloneImageLine(target)) return;

  e.preventDefault();
  e.stopImmediatePropagation();
  selectImage(target, 0, firstImageRelSrc(lines[target]));
});

// チェックボックス行の内容先頭（マーカー直後）をまたぐ矢印移動。<input type="checkbox"> は
// contenteditable="false" の空要素で、ネイティブな矢印移動はその前後の要素境界（DIV の子要素
// インデックス）を無音（キャレットが見た目上動かない）のまま 2 回分経由してから隣の行へ渡る
// （□ にキャレットが乗ったように見える・移動が数回分「効かない」ように感じる）。素通りさせる。
// 上下矢印・折り返し内の左右移動には影響しない（境界ちょうどのときだけ発火する）。
// 「ナビには介入しない」方針の例外だが、同じ形（resolveSelectionPoint → lineStartColumn の
// 境界判定＋stopImmediatePropagation）を画像のみの行への矢印移動（このすぐ上のリスナー）が
// 既に持っており、contenteditable="false" なアトミック要素をまたぐ移動という同じ種類の例外として扱う。
document.addEventListener('keydown', (e) => {
  if (composing || selectedImage) return;
  if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  if (!mdView.contains(range.commonAncestorContainer)) return;
  const point = resolveSelectionPoint(range.startContainer, range.startOffset, false);
  if (!point) return;
  const lines = getLines();

  if (e.key === 'ArrowLeft') {
    // チェックボックス行の内容先頭から前の行へ抜ける（現在行のチェックボックスをまたぐ）
    if (point.line <= 0) return;
    if (point.col !== lineStartColumn(point.line)) return;
    if (!isCheckboxLine(lines[point.line] ?? '')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    placeCaretAtRaw(point.line - 1, null);
    return;
  }
  // チェックボックス行へ次の行として入る（次行のチェックボックスをまたぐ）
  if (point.col < (lines[point.line]?.length ?? 0)) return;
  const target = point.line + 1;
  if (target >= lines.length || !isCheckboxLine(lines[target] ?? '')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  placeCaretAtRaw(target, lineStartColumn(target));
});

document.addEventListener('keydown', (e) => {
  if (!selectedImage) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    clearImageSelection();
    // mdView がフォーカスを持ったままだと、フォーカスされた contenteditable には常にキャレットが
    // 要るというブラウザの既定動作で collapsed な selection が即座に再生成されてしまう
    mdView.blur();
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    // 選択を解除して隣の行へ（隣も画像のみの行なら placeCaretAtRaw が連続して選択状態にする）。
    // 端で行が無ければ選択を維持する（何もしない）
    if (selectedImage.line > 0) placeCaretAtRaw(selectedImage.line - 1, null);
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (selectedImage.line < getLines().length - 1) placeCaretAtRaw(selectedImage.line + 1, null);
    return;
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    // 選択を解除して前の行の末尾へ（隣も画像のみの行なら placeCaretAtRaw が連続して選択状態にする）。
    // 端で行が無ければ選択を維持する（何もしない）
    if (selectedImage.line > 0) placeCaretAtRaw(selectedImage.line - 1, null);
    return;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (selectedImage.line < getLines().length - 1) placeCaretAtRaw(selectedImage.line + 1, 0);
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    // DOM 選択が（テストの直接操作等で）selectedImage を経由せずテキスト側へ移っている場合、
    // ここで横取りすると beforeinput 経由のテキスト削除を奪ってしまう。現在の選択が
    // 実際にまだこの画像を覆っているかを確認してから処理する
    if (!selectionStillCoversSelectedImage()) return;
    e.preventDefault();
    if (e.repeat) return; // 押しっぱなしでの多重削除・確認ダイアログ多重表示を防ぐ
    deleteSelectedImage(e.key);
    return;
  }
  // ⌘C/⌘X はここでは拾わない。実アプリではネイティブ Edit メニューの
  // PredefinedMenuItem::copy/cut がショートカットを先取りし、DOM の keydown まで
  // 届かないため（メニュー項目は DOM 選択が無いと無効化もされる）。DOM 選択を張った上で
  // document の copy/cut イベント（下記）を拾う経路に一本化する
  if (e.key === 'Enter') {
    e.preventDefault();
    // Enter は画像の行の直下、Shift+Enter は直上に空行を挿入し、そこへキャレットを置く
    // （画像が先頭行でも Shift+Enter で上に行を作れるよう、挿入位置は画像の行インデックス自体）。
    // applyLines が rawContent 更新 → renderAll → placeCaretAtRaw → scheduleSave の順で
    // 行挿入の作法に揃えて処理する
    const lines = getLines();
    const insertAt = e.shiftKey ? selectedImage.line : selectedImage.line + 1;
    lines.splice(insertAt, 0, '');
    clearImageSelection();
    applyLines(lines, insertAt, 0);
  }
  // その他の印字キーは何もしない
});

// 別の場所をクリックすると選択解除（選択中の画像自身・リサイズハンドルへのクリックは除く。
// mousedown で先に消しておくことで、別画像をクリックした場合も mouseup 側の選択処理と
// 素直に入れ替わる）
document.addEventListener('mousedown', (e) => {
  if (!selectedImage) return;
  if (e.target.closest('.img-selected') || e.target.closest('.img-resize-handle')) return;
  clearImageSelection();
});

// ── Drag Window ───────────────────────────────────
titlebar.addEventListener('mousedown', (e) => {
  if (e.target.closest('.btn') || e.target.closest('.color-picker')) return;
  appWindow.startDragging();
});

// ── Save Position/Size on Move & Resize ───────────
let geoTimer = null;
function scheduleGeoSave() {
  clearTimeout(geoTimer);
  geoTimer = setTimeout(async () => {
    try {
      const sf   = await appWindow.scaleFactor();
      const pos  = await appWindow.outerPosition();
      const size = await appWindow.outerSize();
      const lpos  = pos.toLogical(sf);
      const lsize = size.toLogical(sf);
      fireInvoke('update_note_geometry', {
        id: noteId,
        x: lpos.x,
        y: lpos.y,
        width: lsize.width,
        height: lsize.height,
      }, I18N.t('toastSaveFailed'));
    } catch {
      // Window might be closing
    }
  }, 500);
}

// ── Buttons ───────────────────────────────────────
newBtn.addEventListener('click', () => {
  fireInvoke('create_note', undefined, I18N.t('toastCreateFailed'));
});

document.getElementById('btn-delete').addEventListener('click', async () => {
  await flushContent();
  fireInvoke('delete_note', { id: noteId }, I18N.t('toastDeleteFailed'));
});

colorBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  picker.classList.toggle('open');
});

// Color dots
document.querySelectorAll('.color-dot').forEach(dot => {
  dot.addEventListener('click', () => {
    const color = dot.dataset.color;
    applyColor(color);
    fireInvoke('update_note_color', { id: noteId, color }, I18N.t('toastSaveFailed'));
    picker.classList.remove('open');
  });
});

// ── Pin Button ──────────────────────────────────────
pinBtn.addEventListener('click', togglePin);

// Close picker on click outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('#color-picker') && !e.target.closest('#btn-color')) {
    picker.classList.remove('open');
  }
});

// ── Zoom Shortcuts (⌘+ / ⌘- / ⌘0) ───────────────
function resetZoom() {
  currentZoom = 100;
  applyZoom(100);
  fireInvoke('update_note_zoom', { id: noteId, zoom: 100 }, I18N.t('toastSaveFailed'));
}

// Listen for zoom events from app menu (only apply to focused window)
const unlisteners = [];
unlisteners.push(appWindow.onMoved(() => scheduleGeoSave()));
unlisteners.push(appWindow.onResized(() => scheduleGeoSave()));
unlisteners.push(listen('zoom', (e) => {
  if (!document.hasFocus()) return;
  if (e.payload === 'in') changeZoom(+1);
  else if (e.payload === 'out') changeZoom(-1);
  else if (e.payload === 'reset') resetZoom();
}));
unlisteners.push(listen('edit-history', (e) => {
  if (!document.hasFocus()) return;
  if (e.payload === 'undo') performUndo();
  else if (e.payload === 'redo') performRedo();
}));
unlisteners.push(listen('select-all', () => {
  if (!document.hasFocus()) return;
  // IME 変換中に selectAllNote() が確定前の入力を巻き込まないよう、performUndo と同じ
  // ガードで防ぐ
  if (composing || applyingHistory || deletingImage) return;
  selectAllNote();
}));

// Listen for context menu events (targeted to this window via emit_to)
unlisteners.push(appWindow.listen('ctx-toggle-pin', () => togglePin()));
unlisteners.push(appWindow.listen('ctx-zoom', (e) => {
  if (e.payload === 'in') changeZoom(+1);
  else if (e.payload === 'out') changeZoom(-1);
  else if (e.payload === 'reset') resetZoom();
}));
// Rust has already saved the color; only update the UI here
unlisteners.push(appWindow.listen('ctx-apply-color', (e) => applyColor(e.payload)));

// ── Listen for settings changes ──────────────────
unlisteners.push(listen('settings-changed', (e) => {
  applySettings(e.payload);
  I18N.setLang(e.payload.resolved_language);
  // ピンボタンはピン状態に応じてラベルを出し分けるため data-i18n* を持たず、
  // applyDom の対象外。ここで明示的にラベルを更新する
  applyPinState(pinBtn.classList.contains('active'));
  // プレースホルダは renderMarkdown が生成する DOM なので applyDom では届かない
  if (!rawContent) renderAll();
}));

// ── Cleanup on window close ──────────────────────
window.addEventListener('beforeunload', () => {
  // デバウンス中の保存を取りこぼさずに保存する（同値なら history 側の同値ガードで無視されるだけ
  // なので、保留タイマーが無いときに呼んでも問題ない）
  saveNow();
  clearTimeout(saveTimer);
  clearTimeout(geoTimer);
  Promise.all(unlisteners).then(fns => fns.forEach(fn => fn()));
});

// ── Context Menu (native via Tauri) ──────────────────
document.addEventListener('contextmenu', async (e) => {
  if (e.shiftKey) return;
  e.preventDefault();
  // 「Markdown をコピー」の対象は、メニュー表示前のこの時点で計算して退避しておく。
  // 直後の flushContent() は入力中の行を renderAll() で描画し直しうり、DOM 選択（Range）が
  // 生きたまま invoke → メニュー表示まで持つ保証が無いため。resolveSelectionRange は未クローズの
  // コードフェンスなど選択範囲の形によっては例外を投げうるため、ここで拾って握りつぶす
  // （投げっぱなしにすると e.preventDefault() 済みのままメニューが一切開かなくなる）
  let hasSelection = false;
  try {
    const sel = window.getSelection();
    if (sel.rangeCount && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      if (mdView.contains(range.commonAncestorContainer)) {
        const markdown = resolveSelectionRange(range);
        // 空文字（可視文字ゼロ行の退化ケース等）なら、空のクリップボード書き込みを防ぐため
        // 選択なし扱いにする（Rust 側は hasSelection が false ならメニュー項目自体を出さない）
        if (markdown) {
          pendingMarkdownCopy = markdown;
          hasSelection = true;
        }
      }
    }
  } catch (err) {
    console.error('resolve selection for context menu failed:', err);
  }
  if (!hasSelection) pendingMarkdownCopy = null;
  // メニューから削除が選ばれてもよいように、開く前に保存を済ませておく
  await flushContent();
  const img = e.target.closest('img[data-rel-src]');
  const relSrc = img?.dataset.relSrc;
  const imagePath = relSrc && isValidImageRelPath(relSrc) ? relSrc : undefined;
  invoke('show_context_menu', {
    id: noteId,
    isPinned: pinBtn.classList.contains('active'),
    currentColor: currentColor,
    imagePath,
    hasSelection,
  }).catch(e => console.error('context menu failed:', e));
});

// 右クリックメニューの「Markdown をコピー」。contextmenu ハンドラが退避した
// pendingMarkdownCopy をここで消費する（選択が無ければ Rust 側はメニュー項目自体を出さない）
unlisteners.push(appWindow.listen('ctx-copy-markdown', () => {
  const text = pendingMarkdownCopy;
  pendingMarkdownCopy = null;
  if (text == null) return;
  invoke('copy_markdown', { text }).catch(e => console.error('copy markdown failed:', e));
}));

// ── Expose for Playwright tests ──────────────────────
window.htmlToMarkdown = htmlToMarkdown;
// 付箋のソーステキスト（常に最新。デバウンスされるのは Rust 側への保存だけ）
window.getRawContent = () => rawContent;
window.placeCaretAtRaw = placeCaretAtRaw;
window.renderMarkdown = renderMarkdown;
window.changeZoom = changeZoom;
window.resetZoom = resetZoom;
window.performUndo = performUndo;
window.performRedo = performRedo;
window.resolveSelectionRange = resolveSelectionRange;
window.selectAllNote = selectAllNote;
// インライン生表示（reveal）の現在の状態。selectionchange 駆動で非同期に確定するため、
// テストは DOM の見た目だけでなくこの値で「reveal が確定したか」を待てる
window.getRevealState = () => revealState;
// 現在のキャレット（collapsed のときのみ）の (line, col) を、アプリ本体と同じ resolveSelectionPoint
// で求めて返す。行に装飾（可視 ≠ raw）があると DOM のテキスト長からの単純な逆算では raw 列を
// 正しく復元できないため、テストはこちらを使う
window.getCaretRawPosition = () => {
  const sel = window.getSelection();
  if (!sel.rangeCount || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  return resolveSelectionPoint(range.startContainer, range.startOffset, false);
};


// ── Keyboard: color dots (Enter/Space/Arrow) ───────
document.querySelectorAll('.color-dot').forEach(dot => {
  dot.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      dot.click();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const group = [...dot.parentElement.querySelectorAll('[role="radio"]')];
      const idx = group.indexOf(dot);
      const next = e.key === 'ArrowRight'
        ? group[(idx + 1) % group.length]
        : group[(idx - 1 + group.length) % group.length];
      dot.setAttribute('tabindex', '-1');
      next.setAttribute('tabindex', '0');
      next.focus();
    }
  });
});

// ── ⌘W to close window ─────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
    e.preventDefault();
    getCurrentWebviewWindow().close();
  }
});

// ── Init ──────────────────────────────────────────
loadNote();
