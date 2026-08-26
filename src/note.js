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
// rawContent が唯一の真実。activeStart/activeEnd は今だけ生 Markdown で
// 表示しているブロックの行範囲（通常行では両者が同じ値）。
let rawContent = '';
let activeStart = null;
let activeEnd = null;
let composing = false;

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

// ── Render / Active Line ──────────────────────────
const getLines = () => rawContent.split('\n');
const activeEditor = () => mdView.querySelector('.raw-editor');
// contenteditable は入力中に NBSP を混ぜてくるので読み出し時に正規化する。
// 1 文字 1 文字の置換なので DOM 側のオフセットとはずれない。
const editorText = (ed) => ed.textContent.replace(/\u00A0/g, ' ');

function renderAll() {
  // 描画済み DOM を丸ごと差し替えるため、直前まで指していた画像の参照ごとハンドルを消す
  // （放置すると detached な img へ書き込む・別画像の上にハンドルが残る事故になる）
  hideHandle();
  mdView.innerHTML = renderMarkdown(rawContent);
  applySelectionHighlight();
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

function placeCaret(el, offset) {
  const at = nodeAt(el, offset);
  const sel = window.getSelection();
  const range = document.createRange();
  if (at) range.setStart(at.node, at.offset);
  else range.setStart(el, 0);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function caretOffset(el) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return 0;
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().length;
}

/** 生エディタ内のキャレット位置を、文書全体での (行番号, 列) に変換する。 */
function caretLineCol(ed) {
  const before = editorText(ed).slice(0, caretOffset(ed)).split('\n');
  return { line: activeStart + before.length - 1, col: before[before.length - 1].length };
}

/**
 * block（差し替え前の描画済みブロック）が画像を含む場合、その描画結果を編集不可の
 * プレビューとして複製する。data-line 系属性は自身だけでなく子孫（チェックボックスの
 * input 等）にも付いており、残すと findBlock の誤マッチだけでなくチェックボックスが
 * Tab 到達可能なまま change を発火させ得るため、複製全体から剥がす。
 *
 * inert は複製した中身（clone）にだけ立てる。ラッパー（preview）ごと inert にすると
 * ポインタイベントのヒットテスト自体から外れ、CSS の pointer-events: auto（mdView の
 * mouseup ハンドラでプレビュー自身へのクリックを識別するための仕掛け）が効かなくなり、
 * クリックが背後の mdView へ抜けて「余白クリック→最終行へ」に誤爆する。
 *
 * block.el はまだ DOM に接続されたまま（置き換え前）なので、その img の実測サイズを
 * clone 側の img へ固定で書き込む（詳細は下のコメント参照）。実測前（画像読み込み中）の
 * block.el ではサイズが定まらないため何もしない。
 */
function buildImagePreview(block) {
  if (!block || !block.el.querySelector('img[data-rel-src]')) return null;
  const preview = document.createElement('div');
  preview.className = 'raw-editor-preview';
  const clone = block.el.cloneNode(true);
  clone.removeAttribute('data-line');
  clone.removeAttribute('data-line-end');
  clone.querySelectorAll('[data-line], [data-line-end]').forEach((el) => {
    el.removeAttribute('data-line');
    el.removeAttribute('data-line-end');
  });
  // width・height の両方を明示指定して clone 側の img のボックスを固定する。片方
  // （height）だけ固定すると、clone 自身の画像デコード・レイアウトのタイミングに
  // width が左右され、結果的に高さもアスペクト比ごと揺れうる。幅も含めて数値で
  // 固定してしまえば、clone の img が実際にいつ・どう読み込まれるかに一切依存しない。
  //
  // getBoundingClientRect() はズーム後（画面表示）のサイズを返す。CSS の width/height は
  // ズーム前（ローカル座標）の値として解釈され、ズームは祖先の .note がまとめて
  // 掛け直すため、画面表示のサイズをそのまま書き込むとズーム分が二重に掛かってしまう
  // （例: 50% ズームなら本来の半分のサイズで描画される）。currentZoom で割り戻して
  // ローカル座標に変換してから書き込む
  const zoomFactor = currentZoom / 100;
  const sourceImages = block.el.querySelectorAll('img[data-rel-src]');
  const cloneImages = clone.querySelectorAll('img[data-rel-src]');
  sourceImages.forEach((img, idx) => {
    const rect = img.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) return;
    cloneImages[idx].style.width = `${rect.width / zoomFactor}px`;
    cloneImages[idx].style.height = `${rect.height / zoomFactor}px`;
  });
  clone.inert = true;
  preview.appendChild(clone);
  return preview;
}

// ── Image Selection ───────────────────────────────
// 画像のみの行（前後空白のみの `![alt|width](images/...)`）は生表示に入らず、代わりに
// 「選択状態」を持つ（enterLine が唯一の入口）。選択は 1 画像のみ（複数選択なし）で、
// { line, occurrence, relSrc } を保持する。line/occurrence は Rust 側の画像削除
// （`delete_image` コマンド）が対象を 1 箇所だけに絞るのと同じ単位（rewriteImageWidth /
// imageOccurrenceInLine と同じ考え方）。
let selectedImage = null;

/** 選択を解除し、ハイライト用クラスも剥がす。 */
function clearImageSelection() {
  if (!selectedImage) return;
  selectedImage = null;
  // querySelectorAll で念のため複数剥がす（1 画像のみの不変条件を守る側の防御）
  mdView.querySelectorAll('.img-selected').forEach(el => el.classList.remove('img-selected'));
}

/**
 * selectedImage が指す img 要素に選択枠（.img-selected）を付け直す。renderAll() の直後
 * （mdView.innerHTML を丸ごと差し替えた直後）に呼び、選択状態を新しい DOM へ引き継ぐ。
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
 * 生表示中なら書き戻して閉じる。
 */
function selectImage(line, occurrence, relSrc) {
  commitActive();
  // 選択は 1 画像のみ。次の選択を立てる前に必ず前の選択を解除する
  // （↑↓ で画像のみの行から画像のみの行へ直接移る経路は enterLine の
  // 「非画像なら clearImageSelection」を通らないため、ここで解除しないと 2 つ同時に残る）
  clearImageSelection();
  if (!relSrc || !isValidImageRelPath(relSrc)) return;
  selectedImage = { line, occurrence, relSrc };
  applySelectionHighlight();
}

/** 行 lineIdx を生 Markdown に差し替え、col 列にキャレットを置く（col が null なら行末）。 */
function enterLine(lineIdx, col) {
  commitActive();
  // 変換中の行から離れると compositionend が来ないまま要素が消えるので、
  // フラグを持ち越さない（残ると次の行でキー操作が全て無視される）
  composing = false;
  const lines = getLines();
  const i = Math.max(0, Math.min(lineIdx, lines.length - 1));
  const block = findBlock(i);
  // 画像のみの行は生表示に入らず、選択状態になる（enterLine の入口での唯一の関所）。
  // ただし未終端フェンスの中では行の見た目が画像のみでも実際には画像として描画されない
  // （<pre> の中の生テキスト）ため、単独ブロック（フェンスでない）のときだけ対象にする
  const isStandalone = !block || block.start === block.end;
  if (isStandalone && isImageOnlyLine(lines[i] ?? '')) {
    selectImage(i, 0, firstImageRelSrc(lines[i]));
    return;
  }
  clearImageSelection();
  activeStart = block ? block.start : i;
  activeEnd = block ? block.end : i;

  const preview = buildImagePreview(block);

  const ed = document.createElement('div');
  ed.id = 'editor';
  // 画像を含む行も atomic（折り返さず横スクロール）にする。images/<uuid> の記法が
  // 折り返して 2〜3 行になると、プレビューと合わせた高さで全体が下にずれるため、
  // 高さの増加を 1 行分に抑える。has-preview は「同じ記法・画像だ」と分かるよう
  // ed とプレビューを 1 枚のカードに見せるための CSS フック（下側の角丸を落とす）
  ed.className = 'raw-editor'
    + (activeEnd > activeStart || preview ? ' atomic' : '')
    + (preview ? ' has-preview' : '');
  ed.contentEditable = 'true';
  ed.setAttribute('aria-label', I18N.t('noteContentAriaLabel'));
  ed.textContent = lines.slice(activeStart, activeEnd + 1).join('\n');

  // 空の付箋はプレースホルダしか無いので、差し替え先が無い
  if (block) block.el.replaceWith(ed);
  else { mdView.innerHTML = ''; mdView.appendChild(ed); }
  if (preview) ed.after(preview);

  bindEditor(ed);
  ed.focus();
  const blockLines = lines.slice(activeStart, activeEnd + 1);
  const line = lines[i] ?? '';
  placeCaret(ed, blockOffset(blockLines, i - activeStart, col == null ? line.length : Math.min(col, line.length)));
}

/** 生エディタの内容を rawContent へ書き戻す。DOM は触らない（入力中に呼ばれる）。 */
function snapshotContent() {
  if (activeStart == null) return;
  const ed = activeEditor();
  if (!ed) return;
  const lines = getLines();
  const edited = editorText(ed).split("\n");
  lines.splice(activeStart, activeEnd - activeStart + 1, ...edited);
  activeEnd = activeStart + edited.length - 1;
  rawContent = lines.join('\n');
}

/** 書き戻したうえで生表示をやめ、全体を描画し直す。 */
function commitActive() {
  if (activeStart == null) return;
  snapshotContent();
  activeStart = activeEnd = null;
  renderAll();
}

/** 行構成そのものが変わる編集（分割・結合・複数行ペースト）の共通後処理。 */
function applyLines(lines, caretLine, caretCol) {
  activeStart = activeEnd = null;
  rawContent = lines.join('\n');
  renderAll();
  enterLine(caretLine, caretCol);
  scheduleSave();
}

// ── Click → Enter Line ────────────────────────────
/**
 * クリック位置を生 Markdown の列に戻す。描画テキストには行頭マーカーが
 * 含まれないぶんを足し戻す。インライン記法（** など）の分だけ列はずれる。
 */
function rawColFromPoint(el, line, e) {
  const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (!range || !el.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  // 番号つきリストは連番が DOM 側のテキストとして出ているぶんを差し引く
  const num = el.querySelector('.md-order-num');
  const domPrefix = num ? num.textContent.length + 1 : 0;
  const visible = Math.max(0, pre.toString().length - domPrefix);
  return Math.min(markerLength(line) + visible, line.length);
}

// プレビューへの mousedown はフォーカス移動ごと止める。既定に任せると生エディタが blur →
// commitActive の再描画でプレビューが消えてレイアウトが詰まり、mouseup 時に再ヒットテストする
// エンジン（WebKit）では同じ画面座標に来た別の行へ編集が飛んでしまう
mdView.addEventListener('mousedown', (e) => {
  if (e.target.closest('.raw-editor-preview')) e.preventDefault();
});

// mouseup で拾う（mousedown を潰すとドラッグでの範囲選択ができなくなるため）
mdView.addEventListener('mouseup', (e) => {
  // 画像リサイズのドラッグ確定はここでは扱わない（別のリスナーが担当。生表示に入らせない）
  if (dragState) return;
  // プレビューは pointer-events: auto でヒットターゲットになるが、生表示への遷移対象ではない。
  // 無視しないと「余白クリック」扱いになり、キャレットが最終行へ飛んでしまう
  if (e.target.closest('.raw-editor-preview')) return;
  if (e.target.closest('.raw-editor')) return;
  // リンクの中（画像を包むリンクも含む）はリンク側のクリック処理に一本化する
  if (e.target.closest('a[data-url]') || e.target.closest('input[type="checkbox"]')) return;
  // 範囲選択したときは生表示に入らない（コピーの邪魔をしない）
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
    // 余白クリックは最終行の行末へ。最終行が画像のみの行なら enterLine が選択状態にする
    enterLine(lines.length - 1, null);
    return;
  }
  // フェンスは行単位のマッピングを持たないので末尾に置く
  if (el.dataset.lineEnd != null) { enterLine(Number(el.dataset.lineEnd), null); return; }
  const lineIdx = Number(el.dataset.line);
  // 画像のみの行の余白クリックも enterLine が選択状態にする
  enterLine(lineIdx, rawColFromPoint(el, lines[lineIdx] ?? '', e));
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
  snapshotContent(); // 別の行を生表示中でもその編集を落とさない
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

/** ドラッグ確定時の書き戻し。別行が生表示中なら先に確定してから該当行を書き換える。 */
function applyImageWidth(img, relSrc, width) {
  const lineEl = img.closest('[data-line]');
  const lineIdx = lineEl ? Number(lineEl.dataset.line) : null;
  const occurrence = lineEl ? imageOccurrenceInLine(lineEl, img, relSrc) : 0;
  commitActive();
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

// ── Markdown auto-continue on Enter ─────────────
/** Enter で行を分割する。リスト・引用の途中なら次の行へプレフィックスを引き継ぐ。 */
function splitLine(ed) {
  snapshotContent();
  const { line, col } = caretLineCol(ed);
  const lines = getLines();
  const cur = lines[line];
  // フェンス内は素の改行だけ入れる
  let prefix = activeEnd > activeStart ? null : getAutoPrefix(cur);

  if (prefix !== null) {
    // キャレットがプレフィックスより手前なら自動継続しない
    const { indent, stripped } = stripIndent(cur);
    for (const pat of LIST_PATTERNS) {
      const m = stripped.match(pat.re);
      if (m) {
        if (col < indent.length + m[1].length) prefix = null;
        break;
      }
    }
  }

  if (prefix !== null && isEmptyListItem(cur)) {
    // 中身のないリスト項目 → プレフィックスを消して継続を打ち切る
    lines[line] = '';
    applyLines(lines, line, 0);
    return;
  }

  lines[line] = cur.slice(0, col);
  const after = cur.slice(col);
  lines.splice(line + 1, 0, prefix === null ? after : prefix + after.replace(/^ /, ''));
  applyLines(lines, line + 1, prefix === null ? 0 : prefix.length);
}

/** Backspace / Delete による行の結合。 */
function mergeLine(ed, withPrevious) {
  snapshotContent();
  const { line, col } = caretLineCol(ed);
  const lines = getLines();
  if (withPrevious) {
    if (col !== 0 || line === 0) return false;
    const mergeCol = lines[line - 1].length;
    lines[line - 1] += lines[line];
    lines.splice(line, 1);
    applyLines(lines, line - 1, mergeCol);
  } else {
    if (col !== lines[line].length || line >= lines.length - 1) return false;
    lines[line] += lines[line + 1];
    lines.splice(line + 1, 1);
    applyLines(lines, line, col);
  }
  return true;
}

// ── Tab / Shift+Tab indent ──────────────────────
function indentLine(ed, outdent) {
  const { line, col } = caretLineCol(ed);
  const blockLines = editorText(ed).split("\n");
  const idx = line - activeStart;
  const lineStart = blockOffset(blockLines, idx, 0);
  const caret = blockOffset(blockLines, idx, col);
  const sel = window.getSelection();
  const range = document.createRange();

  if (outdent) {
    const spaces = blockLines[idx].startsWith('  ') ? 2 : (blockLines[idx].startsWith(' ') ? 1 : 0);
    if (!spaces) return;
    const from = nodeAt(ed, lineStart), to = nodeAt(ed, lineStart + spaces);
    if (!from || !to) return;
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete');
    placeCaret(ed, Math.max(lineStart, caret - spaces));
  } else {
    const from = nodeAt(ed, lineStart);
    if (from) {
      range.setStart(from.node, from.offset);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand('insertText', false, '  ');
    placeCaret(ed, caret + 2);
  }
}

// ── Paste: rich text links → markdown, otherwise plain ──
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

function nodeToMd(node, imageMap) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  // Strip script/style tags entirely — their text content is never useful
  if (tag === 'script' || tag === 'style') return '';
  const inner = Array.from(node.childNodes).map(child => nodeToMd(child, imageMap)).join('');
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
      const parent = node.parentElement?.tagName.toLowerCase();
      if (parent === 'ol') {
        const idx = Array.from(node.parentElement.children).indexOf(node) + 1;
        return `${idx}. ${inner}\n`;
      }
      return `- ${inner}\n`;
    }
    case 'br':                 return '\n';
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

/**
 * リッチテキストなら markdown に変換し、そうでなければプレーンテキストを返す。
 * 変換結果が空／空白のみ（blob: / file: 画像だけで alt も無い等）になった場合は、
 * 挿入が完全に消えてしまわないよう text にフォールバックする（同期・非同期どちらの経路でも）。
 */
function toMarkdown(text, html) {
  if (!html || !/<(?:a|strong|b|em|i|del|s|code|h[1-3]|blockquote|[uo]l|li|img)\b/i.test(html)) {
    return text;
  }
  const converted = htmlToMarkdown(html);
  if (converted instanceof Promise) {
    return converted.then(md => (md.trim() ? md : text));
  }
  return converted.trim() ? converted : text;
}

/**
 * 生エディタへのテキスト挿入。改行を含む場合は contenteditable に任せず
 * 行配列へ splice する。ブラウザが入れる div/br は textContent から消えるため、
 * 任せると rawContent と表示が食い違う。
 */
function insertIntoEditor(ed, inserted) {
  if (!inserted.includes('\n')) {
    document.execCommand('insertText', false, inserted);
    snapshotContent();
    scheduleSave();
    return;
  }
  const sel = window.getSelection();
  if (!sel.isCollapsed) document.execCommand('delete');
  snapshotContent();
  const { line, col } = caretLineCol(ed);
  const lines = getLines();
  const cur = lines[line];
  const parts = inserted.split('\n');
  parts[0] = cur.slice(0, col) + parts[0];
  const tailCol = parts[parts.length - 1].length;
  parts[parts.length - 1] += cur.slice(col);
  lines.splice(line, 1, ...parts);
  applyLines(lines, line + parts.length - 1, tailCol);
}

/**
 * クリップボード画像・ドロップ画像を保存し、生成された相対パスを Markdown 画像記法として挿入する。
 * 保存待ちの `await` 中に生表示が閉じられる／別行へ移ることがあり得るため、戻ってきた時点で
 * ed がまだ同じ行の生表示のままかを確認する。ずれていたら ed への挿入を諦め、fallbackLine
 * （無ければ元の行、それも無ければ末尾）へ直接書き戻して保存する。黙って捨てると保存先の無い
 * 孤児画像になる。ed は null 許容（最初からフォールバック挿入になる）。
 */
async function pasteImage(ed, file, fallbackLine) {
  const lineAtPaste = activeStart;
  let relPath;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    relPath = await invoke('save_pasted_image', bytes);
  } catch (err) {
    console.error('save_pasted_image failed:', err);
    showToast(I18N.t('toastSaveFailed'));
    return;
  }
  const markdown = `![](${relPath})`;
  if (ed?.isConnected && activeStart === lineAtPaste) {
    // 画像記法の直後で行を割り、キャレットを次の行へ送る。画像行から
    // キャレットが外れることで、貼った直後から生の記法ではなく画像として描画される
    insertIntoEditor(ed, markdown + '\n');
    return;
  }
  const lines = getLines();
  const target = Math.min(Math.max(fallbackLine ?? lineAtPaste ?? lines.length - 1, 0), lines.length - 1);
  lines[target] += markdown;
  rawContent = lines.join('\n');
  renderAll();
  await saveNow();
}

/**
 * toMarkdown() の戻り値（同期 string か非同期 Promise<string>）を生エディタへ挿入する。
 * 非同期経路（HTML に data: 画像を含む場合）は await の間に生表示が閉じる／別行へ移ることが
 * あり得るため、pasteImage と同じガードで ed の生存を確認し、ずれていれば fallbackLine
 * （無ければ元の行）へ直接書き戻す。画像を含まない同期経路は await を挟まない。
 */
async function insertConverted(ed, converted, fallbackLine) {
  if (!(converted instanceof Promise)) {
    insertIntoEditor(ed, converted);
    return;
  }
  const lineAtPaste = activeStart;
  const markdown = await converted;
  if (ed?.isConnected && activeStart === lineAtPaste) {
    insertIntoEditor(ed, markdown);
    return;
  }
  const lines = getLines();
  const target = Math.min(Math.max(fallbackLine ?? lineAtPaste ?? lines.length - 1, 0), lines.length - 1);
  lines[target] += markdown;
  rawContent = lines.join('\n');
  renderAll();
  await saveNow();
}

async function onEditorPaste(e) {
  e.preventDefault();
  const ed = e.currentTarget;
  const text = e.clipboardData.getData('text/plain');
  const sel = window.getSelection();
  const selected = sel.toString();

  // 選択テキスト + URL → markdown link
  if (selected && /^https?:\/\/\S+$/.test(text.trim())) {
    document.execCommand('insertText', false, `[${selected}](${text.trim()})`);
    snapshotContent();
    scheduleSave();
    return;
  }

  if (!text) {
    const imageItem = Array.from(e.clipboardData.items)
      .find(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (imageItem) {
      await pasteImage(ed, imageItem.getAsFile());
      return;
    }
  }

  await insertConverted(ed, toMarkdown(text, e.clipboardData.getData('text/html')));
}

/**
 * 画像 File を順番どおりに挿入する。挿入のたびに行番号がずれるため並列にはできない。
 * pasteImage は画像記法の後で改行して次の行へ移るため、enterLine が ed を新しい DOM
 * ノードに差し替える。次の画像もキャレット位置（＝新しい ed）へ続けて挿入できるよう、
 * ループのたびに ed を取り直す。
 */
async function pasteImageFiles(ed, files, fallbackLine) {
  for (const file of files) {
    await pasteImage(ed, file, fallbackLine);
    ed = activeEditor();
  }
}

async function onEditorDrop(e) {
  e.preventDefault();
  const ed = e.currentTarget;
  const imageFiles = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
  if (imageFiles.length) {
    await pasteImageFiles(ed, imageFiles);
    return;
  }
  // File を含むのに画像が無いドロップは、黙って無視すると無反応に見えるので知らせる
  //（WKWebView は画像以外のファイルドラッグを drop イベントの発火前に拒否するため、
  // この分岐に届くのはブラウザ由来など File はあるが画像でないドロップに限られる）
  if (isFileDrag(e)) {
    showToast(I18N.t('toastImageDropUnsupported'));
    return;
  }
  const text = e.dataTransfer.getData('text/plain');
  if (!text) return;
  // drop 位置ではなく現在のキャレット位置へ入れる
  await insertConverted(ed, toMarkdown(text, e.dataTransfer.getData('text/html')));
}

/** ドロップ先の要素から挿入対象の行番号を求める。フェンスは行単位のマッピングを持たないので末尾に置く。 */
function dropTargetLine(target) {
  const el = target.closest('[data-line]');
  if (!el) return null;
  return el.dataset.lineEnd != null ? Number(el.dataset.lineEnd) : Number(el.dataset.line);
}

// ── Drop on non-editing note area ─────────────────
// 生表示中でない付箋（.raw-editor が無い状態）へのドロップも画像だけは受ける。
// preventDefault（File ドラッグのみ）は先頭の dragover/drop リスナーが担う
document.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  // 生エディタ上のドロップは onEditorDrop が処理する（二重処理を避ける）
  if (e.target.closest('.raw-editor')) return;
  const imageFiles = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
  // renderAll() で DOM が作り直される前に、ドロップ先の行番号を確定させておく
  const fallbackLine = dropTargetLine(e.target);
  // 別行が生表示中だった場合に備えて確定させる。これをしないと、生表示ブロックの
  // 先頭行末へ誤挿入されたり、activeStart/composing が生表示 DOM ごと取り残されたりする
  commitActive();
  if (!imageFiles.length) {
    showToast(I18N.t('toastImageDropUnsupported'));
    return;
  }
  await pasteImageFiles(null, imageFiles, fallbackLine);
});

// ── Checkbox autocomplete ────────────────────────
function autocompleteCheckbox(ed) {
  const { line, col } = caretLineCol(ed);
  const blockLines = editorText(ed).split("\n");
  const idx = line - activeStart;
  const m = blockLines[idx].slice(0, col).match(CHECKBOX_RE);
  if (!m) return;
  const replacement = m[2].toLowerCase() === 'x' ? `${m[1]} [x] ` : `${m[1]} [ ] `;

  const from = nodeAt(ed, blockOffset(blockLines, idx, 0));
  const to = nodeAt(ed, blockOffset(blockLines, idx, col));
  if (!from || !to) return;
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  sel.removeAllRanges();
  sel.addRange(range);
  document.execCommand('insertText', false, replacement);
}

// ── Auto-Save Content ─────────────────────────────
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  return fireInvoke('update_note_content', { id: noteId, content: rawContent }, I18N.t('toastSaveFailed'));
}

/**
 * デバウンス中の入力と生表示中の行を書き戻して保存し、完了を待つ。
 * 削除の空判定はバックエンドのメモリ上の内容で行われるため、削除前に
 * これを挟まないと、入力直後の付箋が空とみなされて内容ごと消える。
 */
function flushContent() {
  if (!saveTimer && activeStart == null) return Promise.resolve();
  snapshotContent();
  return saveNow();
}

// ── Raw Editor Bindings ───────────────────────────
function bindEditor(ed) {
  ed.addEventListener('compositionstart', () => { composing = true; });
  ed.addEventListener('compositionend', () => {
    composing = false;
    snapshotContent();
    scheduleSave();
  });

  ed.addEventListener('keydown', (e) => {
    // WebKit は変換確定の Enter より先に compositionend を出すので、composing も
    // isComposing も false になっている。IME 経由の keydown は keyCode が 229 になる。
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      // 分割結果の新しい行が画像のみの行になり enterLine が選択状態にすることがある
      // （selectImage が selectedImage を立てる）。この 1 回の keydown が document まで
      // 伝播すると、画像選択用のキー処理が同じキーで二重発火してしまうため止める
      e.stopPropagation();
      splitLine(ed);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      indentLine(ed, e.shiftKey);
      snapshotContent();
      scheduleSave();
      return;
    }
    // 選択が生エディタの外へ広がらないように自前で全選択する
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(ed);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    if (e.key === 'ArrowUp' && activeStart > 0) {
      const { line, col } = caretLineCol(ed);
      // 移動先が画像のみの行なら enterLine が選択状態に切り替える（スキップはしない）。
      // selectedImage を立てる呼び出しなので、後段の画像選択用キー処理へ二重に届かせない
      if (line === activeStart) { e.preventDefault(); e.stopPropagation(); enterLine(activeStart - 1, col); }
      return;
    }
    if (e.key === 'ArrowDown') {
      const { line, col } = caretLineCol(ed);
      if (line === activeEnd && activeEnd < getLines().length - 1) {
        e.preventDefault();
        e.stopPropagation();
        enterLine(activeEnd + 1, col);
      }
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && window.getSelection().isCollapsed) {
      // 結合結果の行が画像のみの行になり enterLine が選択状態にすることがある。同じ理由で止める
      if (mergeLine(ed, e.key === 'Backspace')) { e.preventDefault(); e.stopPropagation(); }
    }
  });

  ed.addEventListener('input', (e) => {
    if (!e.isComposing && e.data === ']') autocompleteCheckbox(ed);
    snapshotContent();
    scheduleSave();
  });

  ed.addEventListener('paste', onEditorPaste);
  ed.addEventListener('drop', onEditorDrop);

  ed.addEventListener('blur', (e) => {
    // 色ピッカー等のボタンへフォーカスが移っただけなら生表示を保つ
    if (e.relatedTarget && e.relatedTarget.closest('.note')) return;
    setTimeout(() => {
      if (composing) return;
      // 別の行へ移ったときは enterLine が既に差し替え済みなので何もしない
      if (!ed.isConnected) return;
      commitActive();
    }, 0);
  });
}

// ── Cross-line Selection Guard ────────────────────
// 行をまたぐ選択のまま編集すると管理外の DOM が壊れ、rawContent と
// 表示が乖離する。コピーは通し、破壊的な操作だけを止める。
const NAV_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End',
  'PageUp', 'PageDown', 'Escape', 'Shift', 'Meta', 'Control', 'Alt',
]);

function blockOf(node) {
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  return el ? el.closest('[data-line], .raw-editor') : null;
}

function selectionSpansLines() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  return blockOf(range.startContainer) !== blockOf(range.endContainer);
}

document.addEventListener('keydown', (e) => {
  if (!selectionSpansLines()) return;
  if (e.metaKey || e.ctrlKey) {
    if (e.key === 'x' || e.key === 'v') e.preventDefault();
    return;
  }
  if (NAV_KEYS.has(e.key)) return;
  // preventDefault はブラウザ既定の編集を止めるだけで伝播は止まらない。
  // 生エディタ側の keydown（Enter の行分割・Tab のインデント）にも
  // 届かせないよう、ここで伝播ごと打ち切る。
  e.preventDefault();
  e.stopPropagation();
}, true);

for (const type of ['cut', 'paste', 'drop']) {
  document.addEventListener(type, (e) => {
    // 画像ドロップは行をまたぐ選択が残っていても許可する（選択範囲への破壊的な書き込みではない）
    if (type === 'drop' && isFileDrag(e)) return;
    if (!selectionSpansLines()) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

// ── Image Selection: keyboard ──────────────────────
// 画像選択中は生エディタが無い（フォーカス先の contenteditable が存在しない）ため、
// document レベルの keydown で拾う。selectedImage が無いときは即 return するので、
// 色ドットの矢印キーナビゲーションや ⌘W 等、他のキー処理とは衝突しない。
// 削除処理中の多重発火ガード（キーリピートでの確認ダイアログ多重表示・二重削除を防ぐ）
let deletingImage = false;

async function deleteSelectedImage(key) {
  if (!selectedImage || deletingImage) return;
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
      newContent = await invoke('delete_image', {
        id: noteId,
        imagePath: relSrc,
        imageLine: line,
        imageOccurrence: occurrence,
      });
    } catch (err) {
      console.error('delete_image failed:', err);
      showToast(I18N.t('toastDeleteImageFailed'));
      return;
    }
    // キャンセル（confirm_before_delete で拒否）・対象が既に無い場合は選択を保ったまま何もしない
    if (newContent == null) return;
    clearImageSelection();
    rawContent = newContent;
    renderAll();
    const lines = getLines();
    // 削除後のキャレット位置: 来た方向（押されたキー）の逆側優先。Backspace は前の行
    // （mergeLine の「前の行へ戻る」と同じ向き）。先頭行を消した場合は前が無いので
    // 先頭（0）に留まる（末尾へは飛ばさない）。Delete はそのまま同じ index
    // （消えた行の次が繰り上がってくる）。それも無ければ末尾へ
    const preferred = key === 'Backspace' ? Math.max(0, line - 1) : line;
    const target = (preferred >= 0 && preferred < lines.length) ? preferred : lines.length - 1;
    enterLine(target, null);
  } finally {
    deletingImage = false;
  }
}

document.addEventListener('keydown', (e) => {
  if (!selectedImage) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    clearImageSelection();
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    // 選択を解除して隣の行へ（隣も画像のみの行なら enterLine が連続して選択状態にする）。
    // 端で行が無ければ選択を維持する（何もしない）
    if (selectedImage.line > 0) enterLine(selectedImage.line - 1, null);
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (selectedImage.line < getLines().length - 1) enterLine(selectedImage.line + 1, null);
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    deleteSelectedImage(e.key);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    // Enter は画像の行の直下、Shift+Enter は直上に空行を挿入し、そこへキャレットを置く
    // （画像が先頭行でも Shift+Enter で上に行を作れるよう、挿入位置は画像の行インデックス自体）。
    // applyLines が rawContent 更新 → renderAll → enterLine → scheduleSave の順で
    // 行挿入の作法（splitLine 等）に揃えて処理する
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
  // 生表示中の行や保留中のデバウンスを取りこぼさずに保存する
  if (saveTimer || activeStart != null) {
    snapshotContent();
    saveNow();
  }
  clearTimeout(saveTimer);
  clearTimeout(geoTimer);
  Promise.all(unlisteners).then(fns => fns.forEach(fn => fn()));
});

// ── Context Menu (native via Tauri) ──────────────────
document.addEventListener('contextmenu', async (e) => {
  if (e.shiftKey) return;
  e.preventDefault();
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
  }).catch(e => console.error('context menu failed:', e));
});

// ── Expose for Playwright tests ──────────────────────
window.htmlToMarkdown = htmlToMarkdown;
// 生表示中の行を書き戻したうえでの付箋のソーステキスト
window.getRawContent = () => { snapshotContent(); return rawContent; };
window.enterLine = enterLine;
window.renderMarkdown = renderMarkdown;
window.changeZoom = changeZoom;
window.resetZoom = resetZoom;


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
