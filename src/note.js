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
// true の間は scheduleSave の debounce 起動を止める。行またぎ選択のペースト（削除 → 画像保存等の
// 非同期処理 → 挿入）で、削除直後に 300ms のデバウンスが先に切れて editHistory へ「削除だけ」を
// 積んでしまうと、続く挿入が別の undo 手になってしまう。一連の操作が終わるまで保留し、最後に
// まとめて 1 回だけ scheduleSave を呼ぶことで undo を 1 手に保つ
let holdSave = false;

// ── Editor State ──────────────────────────────────
// rawContent が唯一の真実。activeStart/activeEnd は今だけ生 Markdown で
// 表示しているブロックの行範囲（通常行では両者が同じ値）。
let rawContent = '';
let activeStart = null;
let activeEnd = null;
let composing = false;

// 生エディタの keydown ごとに増える通し番号。scheduleShiftArrowClampCheck が
// setTimeout(0) の直前に captureし、発火時に比較する（後続のキー入力が起きていれば
// 破棄する）のに使う。詳細は scheduleShiftArrowClampCheck 参照
let editorKeySeq = 0;

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

/**
 * キャレット位置を可視領域までスクロールする。ArrowLeft/Right 等のネイティブなキャレット
 * 移動は自動でスクロール追従するが、placeCaret による自前のジャンプ（Ctrl+A/E 等）は
 * 追従しない。atomic な行（折り返さず横スクロール、.raw-editor.atomic）で長い行の行末へ
 * 飛ぶと、この呼び出しがないとキャレットが画面外へ出る。
 *
 * キャレット位置に一時的な span を挿し、それを scrollIntoView した上で除去する。
 * span に大きさ（inline-block の 1px 幅）を持たせるのは WebKit 対応で、大きさの無い
 * インライン要素は行頭・行末でレイアウトボックスを持たず scrollIntoView が効かない。
 * span は textContent を持たないため editorText(el) の結果には影響せず、除去後に
 * 同じ数値オフセットで placeCaret し直せば、DOM 上のテキストノード分割の有無に関わらず
 * 元と同じ位置へキャレットを戻せる。
 */
function scrollCaretIntoView(el) {
  const offset = caretOffset(el);
  const at = nodeAt(el, offset);
  const marker = document.createElement('span');
  marker.style.cssText = 'display:inline-block;width:1px;height:1em;';
  if (at) {
    const range = document.createRange();
    range.setStart(at.node, at.offset);
    range.collapse(true);
    range.insertNode(marker);
  } else {
    el.appendChild(marker);
  }
  marker.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  marker.remove();
  // insertNode が分割したテキストノードを繋ぎ直す（放置すると呼ぶたびに断片が増え、
  // IME の変換開始位置がノード境界に当たりやすくなる）。normalize で既存の Range は
  // 無効になるが、直後に数値オフセットでキャレットを置き直すので影響しない
  el.normalize();
  placeCaret(el, offset);
}

/** el 内の (node, offset) を、el の先頭からの文字オフセットへ変換する（caretOffset の
 * 任意ノード版。node/offset は el の子孫を指している前提）。 */
function textOffsetWithin(el, node, offset) {
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(node, offset);
  return pre.toString().length;
}

/** 生エディタ内の文字オフセットを、文書全体での (行番号, 列) に変換する
 * （caretLineCol の任意オフセット版）。 */
function editorOffsetToLineCol(ed, offset) {
  const before = editorText(ed).slice(0, offset).split('\n');
  return { line: activeStart + before.length - 1, col: before[before.length - 1].length };
}

/** 生エディタ内のキャレット位置を、文書全体での (行番号, 列) に変換する。 */
function caretLineCol(ed) {
  return editorOffsetToLineCol(ed, caretOffset(ed));
}

/** 生エディタ内の選択の一端（node, offset）を、文書全体での (行番号, 列) に変換する。 */
function editorPointToLineCol(ed, node, offset) {
  return editorOffsetToLineCol(ed, textOffsetWithin(ed, node, offset));
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
  // 画像に張った DOM 選択も一緒に外す（張ったままだと次に別行を生表示するときに
  // 「範囲選択中は生表示に入らない」ガードへ誤って引っかかる）
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
  // atomic な行（折り返さず横スクロール）へ行末等でキャレットが着地すると、placeCaret だけでは
  // 横スクロール位置が追従せずキャレットが画面外に出ることがあるため、可視位置まで追従させる
  scrollCaretIntoView(ed);
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
  await pasteIntoEditor(e.currentTarget, e.clipboardData);
}

/**
 * clipboardData を生エディタ ed へ実際に反映する（onEditorPaste の本体。行またぎ選択の
 * ペースト（選択を削除してから開いた生エディタへ続けて合流する経路）とも共有する）。
 */
async function pasteIntoEditor(ed, clipboardData) {
  const text = clipboardData.getData('text/plain');
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
    const imageItem = Array.from(clipboardData.items)
      .find(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (imageItem) {
      await pasteImage(ed, imageItem.getAsFile());
      return;
    }
  }

  await insertConverted(ed, toMarkdown(text, clipboardData.getData('text/html')));
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
  if (holdSave) return;
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

// ── Undo / Redo ────────────────────────────────────────────
// 適用中の多重発火を防ぐ（deletingImage と同じ考え方）。⌘Z の押しっぱなしや
// メニューイベントの二重到達があっても history の巻き戻りが 1 回で済むようにする
let applyingHistory = false;

/** history から返った content を適用し、差分行にキャレットを置いて保存する共通処理。 */
async function applyHistoryContent(prevContent, content) {
  if (content == null) return;
  clearImageSelection();
  rawContent = content;
  // renderAll() は生表示中の行を書き戻さない（DOM を丸ごと差し替えるだけ）ため、
  // 古い activeStart/activeEnd を残したままにしない（commitActive と同じ作法）
  activeStart = activeEnd = null;
  renderAll();
  const diffLine = firstDiffLine(prevContent, content);
  if (diffLine != null) {
    enterLine(Math.min(diffLine, getLines().length - 1), null);
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

// ── Raw Editor Bindings ───────────────────────────
function bindEditor(ed) {
  ed.addEventListener('compositionstart', () => { composing = true; });
  ed.addEventListener('compositionend', () => {
    composing = false;
    snapshotContent();
    scheduleSave();
  });

  ed.addEventListener('keydown', (e) => {
    // scheduleShiftArrowClampCheck が setTimeout(0) 待ちの間に後続のキー入力（IME 含む）が
    // 割り込んだかどうかを判定するための通し番号。composing チェックより前でインクリメントし、
    // IME 経由の keydown（後段の早期 return で無視される）でも確実に進める
    editorKeySeq++;
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
    // ⌘A は付箋全体を選択する（selectAllNote）。修飾キーは ⌘ 単独のときだけ効かせる
    // （Ctrl+⌘+A 等の未定義の組み合わせで何もしない macOS 標準に合わせる）。toLowerCase は
    // CapsLock 対応。生エディタ内の keydown で拾うのは、この関数先頭の composing チェックを
    // 経由させるため（変換中の ⌘A で確定前の入力を巻き込んで選択させない）
    if (e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAllNote();
      return;
    }
    // 実機の WKWebView は contenteditable 上で Ctrl+A/E を標準キーバインド（行頭・行末移動）
    // として処理しないため自前実装する。Shift 付き（選択拡張）はこの分岐に入れず、
    // ネイティブの選択拡張に任せる
    const caretKey = e.key.toLowerCase();
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && (caretKey === 'a' || caretKey === 'e')) {
      e.preventDefault();
      const text = editorText(ed);
      const offset = caretOffset(ed);
      const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
      const nlAfter = text.indexOf('\n', offset);
      const lineEnd = nlAfter === -1 ? text.length : nlAfter;
      placeCaret(ed, caretKey === 'a' ? lineStart : lineEnd);
      scrollCaretIntoView(ed);
      return;
    }
    // Shift+矢印がエディタの境界（WebKit/Chromium が選択をクランプする位置）に達すると、
    // ネイティブは選択を伸ばせず、選択が生エディタの外の描画 DOM へ届かない。
    // scheduleShiftArrowClampCheck が preventDefault せずネイティブにまず試させ、
    // 動けなかった（＝クランプされた）ときだけ描画 DOM 側の選択へ変換する
    if (
      e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
      && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'ArrowLeft')
    ) {
      const key = e.key;
      scheduleShiftArrowClampCheck(ed, () => {
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          convertEditorShiftArrowAcrossBoundary(ed, key === 'ArrowDown' ? 'down' : 'up');
        } else {
          convertEditorShiftHorizontalAcrossBoundary(ed, key === 'ArrowRight' ? 'right' : 'left');
        }
      });
      return;
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && activeStart > 0) {
      const { line, col } = caretLineCol(ed);
      // 移動先が画像のみの行なら enterLine が選択状態に切り替える（スキップはしない）。
      // selectedImage を立てる呼び出しなので、後段の画像選択用キー処理へ二重に届かせない
      if (line === activeStart) { e.preventDefault(); e.stopPropagation(); enterLine(activeStart - 1, col); }
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const { line, col } = caretLineCol(ed);
      if (line === activeEnd && activeEnd < getLines().length - 1) {
        e.preventDefault();
        e.stopPropagation();
        enterLine(activeEnd + 1, col);
      }
      return;
    }
    // Shift（選択拡張）・⌥（単語移動）・⌘/Ctrl（行頭/行末移動）付きはこの分岐に入れず、
    // ネイティブの生エディタ内移動に任せる（Ctrl+A/E・⌘A 分岐と同じ 4 修飾キーの並び）。
    // 非 collapsed（選択あり）のときも、caretLineCol が返すのは選択開始位置（左端）なので
    // ここで拾うと「選択を畳む」が「行またぎジャンプ」に化ける。Backspace/Delete 分岐と
    // 同じく isCollapsed で弾き、選択畳みはネイティブに譲る
    if (
      e.key === 'ArrowLeft' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey
      && window.getSelection().isCollapsed && activeStart > 0
    ) {
      const { line, col } = caretLineCol(ed);
      // 行頭のときだけ発動。複数行ブロック（フェンス）の途中の行頭は
      // contenteditable のネイティブ移動（同一エディタ内で前行末尾へ）に任せる
      if (line === activeStart && col === 0) {
        e.preventDefault();
        // 移動先が画像のみの行なら enterLine が選択状態にする（selectImage が
        // selectedImage を立てる）。stopPropagation しないと、この 1 回の keydown が
        // document まで伝播し、画像選択用のキー処理（この直後に登録）が
        // 立ったばかりの selectedImage を見て同じキーで二重に隣へ進めてしまう
        e.stopPropagation();
        enterLine(activeStart - 1, null);
      }
      return;
    }
    if (
      e.key === 'ArrowRight' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey
      && window.getSelection().isCollapsed && activeEnd < getLines().length - 1
    ) {
      const { line, col } = caretLineCol(ed);
      if (line === activeEnd && col === getLines()[line].length) {
        e.preventDefault();
        // 移動先が画像のみの行なら enterLine が選択状態にする。stopPropagation しないと
        // 同じ keydown が document の画像選択用キー処理に届き、二重に隣へ進めてしまう
        e.stopPropagation();
        enterLine(activeEnd + 1, 0);
      }
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && window.getSelection().isCollapsed) {
      // 結合結果の行が画像のみの行になり enterLine が選択状態にすることがある。
      // stopPropagation しないと同じ keydown が document の画像選択用キー処理に届いてしまう
      if (mergeLine(ed, e.key === 'Backspace')) { e.preventDefault(); e.stopPropagation(); }
    }
  });

  // 生エディタ内で mousedown したドラッグが別の描画行の上に達したら、境界を越えたとみなして
  // エディタを commit で閉じ、描画 DOM 上の選択へ切り替える（ed 自身に張るのは
  // 同一行内のドラッグを完全ネイティブのままにするため）。
  ed.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // 左ボタンのみ
    const startRange = caretRangeFromPointCompat(e.clientX, e.clientY);
    if (!startRange || !ed.contains(startRange.startContainer)) return;
    const startLineCol = editorPointToLineCol(ed, startRange.startContainer, startRange.startOffset);
    let converted = false;

    const onMove = (moveEvent) => {
      // mouseup を取りこぼした（ウィンドウ外での release 等）場合の自己回復
      // （onResizeMouseMove と同じ作法）。残ったままだと、ボタンを押していない
      // ただのマウス移動で commitActive が走り生エディタが勝手に閉じてしまう
      if (moveEvent.buttons === 0) {
        onUp();
        return;
      }
      if (converted) {
        // 変換後は commit の再描画でネイティブのドラッグ選択が続かないため、
        // mousemove ごとに自前で終点を追従させる
        const target = caretRangeFromPointCompat(moveEvent.clientX, moveEvent.clientY);
        if (target) window.getSelection().extend(target.startContainer, target.startOffset);
        return;
      }
      const overLine = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest('[data-line]');
      if (!overLine || ed.contains(overLine)) return; // 同一エディタ内のドラッグはネイティブのまま
      converted = true;
      commitActive();
      const anchorPoint = domPointForRawPosition(startLineCol.line, startLineCol.col);
      if (!anchorPoint) return;
      const range = document.createRange();
      range.setStart(anchorPoint.node, anchorPoint.offset);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const target = caretRangeFromPointCompat(moveEvent.clientX, moveEvent.clientY);
      if (target) sel.extend(target.startContainer, target.startOffset);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // ウィンドウ外へドラッグしたまま release される等で mouseup が届かないケースの保険
    window.addEventListener('blur', onUp);
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

// ── Select All (⌘A) ───────────────────────────────
/** ⌘A・Edit メニューの Select All に共通の「付箋全体を選択する」処理。生エディタが開いていれば
 * 書き戻して閉じ、画像選択中ならそれも解除したうえで、描画 DOM 上に付箋の内容全体の Range を張る。
 * 空の付箋（内容が空 1 行のみ）はプレースホルダしか無く選択対象が無いので何もしない。 */
function selectAllNote() {
  commitActive();
  clearImageSelection();
  const lines = getLines();
  if (lines.length === 1 && lines[0] === '') return;
  const range = document.createRange();
  range.selectNodeContents(mdView);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// 生エディタ内の ⌘A は bindEditor 側の keydown（composing チェック込み）が拾うが、
// stopPropagation はしていないため、この document レベルのリスナーにも同じ keydown が
// 届く。bindEditor 側が selectAllNote() で #editor を DOM から外した後にここへ来ると
// activeEditor() は既に null を返し、e.defaultPrevented を見ないと selectAllNote() が
// 二重に走る（冪等なので実害は無いが、ここは意図的に一度だけ実行する契約にする）
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a')) return;
  if (e.defaultPrevented || activeEditor()) return;
  e.preventDefault();
  selectAllNote();
});

// ── Cross-line Selection Guard ────────────────────
// 行をまたぐ選択（markdown-view の描画テキスト上の Range）は resolveSelectionBounds で
// 生 Markdown の範囲へ解決できるため、削除・カット・キャレットの畳み込み・印字可能キーの
// 置換入力・ペーストはここで実際に処理する（削除 + 挿入を 1 回の applyLines にまとめ、undo が
// 1 手で「選択+入力前」に戻るようにする）。IME 打鍵での置換は非対応（生エディタにフォーカスが
// 無いため composition イベント自体が起きず、成立させる経路が無い）。それ以外の組み立てられない
// 破壊的操作（Dead key 等）は一律ブロックする。
const NAV_KEYS = new Set(['Home', 'End', 'PageUp', 'PageDown']);
const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

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

/** 選択が生 Markdown 上で複数行にまたがるか（resolveSelectionBounds で解決できる場合）。
 * コードブロックは複数の raw 行を単一の DOM ブロック（<pre>）で描画するため、
 * selectionSpansLines（DOM ブロックの境界）だけでは「内容行を丸ごと選択したコードブロック」
 * を見逃す。resolveSelectionBounds が返す行番号で判定することでこれを拾う。 */
function selectionSpansRawLines() {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  const ed = activeEditor();
  if (ed && range.intersectsNode(ed)) return false; // 生エディタに触れる選択は既定の編集操作に任せる
  if (!mdView.contains(range.commonAncestorContainer)) return false;
  const bounds = resolveSelectionBounds(range);
  return !!bounds && bounds.start.line !== bounds.end.line;
}

/** 行またぎ選択（生 Markdown の {start, end}）を insertedText で置き換える。start 行の手前と
 * end 行の続きの間へ insertedText を差し込む（改行を含めば複数行に展開される。空文字なら
 * 削除だけになる）。全体を空にすれば空 1 行になる。キャレットは insertedText の直後に置いて
 * 生表示にする（applyLines が rawContent 更新 → renderAll → enterLine → 保存の順で行う。
 * 削除と挿入をここで 1 回の applyLines にまとめることで undo も 1 手にまとまる）。 */
function spliceSelectionRange(bounds, insertedText) {
  const { start, end } = bounds;
  const lines = getLines();
  const prefix = lines[start.line].slice(0, start.col);
  const suffix = lines[end.line].slice(end.col);
  const parts = insertedText.split('\n');
  parts[0] = prefix + parts[0];
  const caretLine = start.line + parts.length - 1;
  const caretCol = parts[parts.length - 1].length;
  parts[parts.length - 1] += suffix;
  lines.splice(start.line, end.line - start.line + 1, ...parts);
  applyLines(lines, caretLine, caretCol);
}

/** start と end が resolveSelectionBounds 上で同一点に解決されたかどうか。hr・空フェンス等の
 * 「可視テキストが 1 つも無い行」は expandZeroVisibleLineSelection が先に行全体へ展開するため
 * ここには来ない（このチェックが捕まえるのは、それ以外の理由で退化した選択だけ）。 */
function boundsAreDegenerate(bounds) {
  return bounds.start.line === bounds.end.line && bounds.start.col === bounds.end.col;
}

/** 選択を置き換える対象になる印字可能キーかどうか。e.key.length === 1 は Backspace・Enter・
 * ArrowLeft 等の名前つきキーを自然に除外する（IME 変換中の keydown は key が "Process" になる
 * ため、isComposing のチェックと合わせて二重に除外される）。⌥+文字（例: ⌥8 → •）は e.key が
 * 変換済みの 1 文字になるため対象に含める。⌥+矢印・⌥Backspace・Dead key 等は e.key.length が
 * 1 にならず、この時点で自然に除外される。⌘/Ctrl 付きは対象外（既定の編集操作に任せる）。 */
function isPrintableReplacementKey(e) {
  return e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.isComposing;
}

/** 現在の DOM 選択を削除向けに判定する（判定フェーズ、resolveSelectionBounds 経由で例外を
 * 投げうる）。生エディタに触れる選択・解決できない選択・退化した選択（可視範囲が空）では
 * null。行またぎに限らず、非空の単一行選択も対象にする（「コピーされる範囲 = 削除される範囲」
 * という設計）。実際の削除は commitSelectionDeletion（変更フェーズ）で行う。 */
function resolveDeletableBounds() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const ed = activeEditor();
  if (ed && range.intersectsNode(ed)) return null; // 生エディタに触れる選択は既定の編集操作に任せる
  const bounds = resolveSelectionBounds(range);
  if (!bounds || boundsAreDegenerate(bounds)) return null;
  return bounds;
}

/** resolveDeletableBounds で得た bounds を実際に置き換える（変更フェーズ）。insertedText を
 * 省略すると削除だけになる（Backspace/Delete/⌘X はこちら）。ここで投げた例外は rawContent と
 * DOM が食い違ったまま止まる致命的なバグであり、判定フェーズの「解決できない選択は既定に
 * 委ねる」とは性質が違うため、呼び出し元は try で包まず伝播させる。 */
function commitSelectionReplacement(bounds, insertedText = '') {
  window.getSelection().removeAllRanges();
  // splice で行番号がずれる前に、stale な画像選択を解いておく。spliceSelectionRange の後だと
  // enterLine が張り直した新しい画像選択・生エディタまでここで消してしまう（開始行が画像のみの
  // 行になったケースで、生エディタも画像選択も無い操作不能状態を招く）
  clearImageSelection();
  spliceSelectionRange(bounds, insertedText);
}

/** 削除だけを行う commitSelectionReplacement のショートハンド。 */
function commitSelectionDeletion(bounds) {
  commitSelectionReplacement(bounds);
}

/** 行またぎ選択中の無修飾矢印キーの畳み先を判定する（判定フェーズ、例外を投げうる）。
 * 左/上は選択開始端、右/下は選択終了端。resolveSelectionBounds が削除向けに正規化した
 * start/end（マーカー行の col 0）ではなく、ユーザーが選択を始め/終えた可視位置
 * （startVisual/endVisual、マーカー直後）を使う。解決できなければ null。 */
function resolveCollapseTarget(key) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const bounds = resolveSelectionBounds(sel.getRangeAt(0));
  if (!bounds) return null;
  const forward = key === 'ArrowRight' || key === 'ArrowDown';
  return forward ? (bounds.endVisual ?? bounds.end) : (bounds.startVisual ?? bounds.start);
}

/** resolveCollapseTarget で得た畳み先へ実際にキャレットを置く（変更フェーズ。enterLine が
 * 該当行を生表示で開く）。 */
function commitCollapse(target) {
  window.getSelection().removeAllRanges();
  enterLine(target.line, target.col);
}

/** cut イベント側で実際に処理できる（選択が生エディタに触れておらず、mdView 内で解決でき、
 * 退化していない）ときの range と bounds。keydown 側で「cut イベントに任せてよいか」を判定
 * するのにも使う（判定フェーズ、例外を投げうる）。 */
function resolveCutSelection() {
  const sel = window.getSelection();
  if (!sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const ed = activeEditor();
  if (ed && range.intersectsNode(ed)) return null; // 生エディタに触れる選択は既定の編集操作に任せる
  if (!mdView.contains(range.commonAncestorContainer)) return null;
  const bounds = resolveSelectionBounds(range);
  if (!bounds || boundsAreDegenerate(bounds)) return null;
  return { range, bounds };
}

// 判定フェーズの呼び出しが例外を投げたことを示す番兵。resolve 結果が null（＝解決できな
// かっただけ）と区別するために使う（前者は既に preventDefault 済み、後者は既定に委ねてよい）。
const RESOLVE_FAILED = Symbol('cross-line-guard-resolve-failed');

/** 判定フェーズ（resolveSelectionBounds 経由で例外を投げうる処理）を try で保護する共通
 * ラッパー。DOM の data-line が rawContent の行数とずれた瞬間（生エディタ書き戻し直後等）に
 * 例外が起こりうるため、判定できないときは安全側（preventDefault + stopPropagation）に倒し、
 * RESOLVE_FAILED を返す。判定結果を使った実際の変更（mutation フェーズ）はこの外で行い、
 * そちらの例外は握り潰さない。 */
function resolveOrBlock(e, resolve) {
  try {
    return resolve();
  } catch (err) {
    console.error('cross-line selection guard failed:', err);
    e.preventDefault();
    e.stopPropagation();
    return RESOLVE_FAILED;
  }
}

document.addEventListener('keydown', (e) => {
  const spans = resolveOrBlock(e, () => selectionSpansLines() || selectionSpansRawLines());
  if (spans === RESOLVE_FAILED) return;

  if (!spans) {
    // 行をまたがない非空の単一行選択も、無修飾の Backspace/⌘X の削除対象にする
    // （コピー範囲と揃える）。⌘/Ctrl/Shift/⌥ 付きは対象外（既定の編集操作に任せる）
    if (!e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'Backspace' || e.key === 'Delete')) {
      const bounds = resolveOrBlock(e, resolveDeletableBounds);
      if (bounds === RESOLVE_FAILED) return;
      if (bounds) {
        e.preventDefault();
        e.stopPropagation();
        commitSelectionDeletion(bounds);
      }
      return;
    }
    // 印字可能キー（Shift のみ許容。⌘/Ctrl/⌥ 付きは既定の編集操作に任せる）は選択を
    // 置き換える（コピー範囲と揃える）
    if (isPrintableReplacementKey(e)) {
      const bounds = resolveOrBlock(e, resolveDeletableBounds);
      if (bounds === RESOLVE_FAILED) return;
      if (bounds) {
        e.preventDefault();
        e.stopPropagation();
        commitSelectionReplacement(bounds, e.key);
      }
    }
    return;
  }

  if (e.metaKey || e.ctrlKey) {
    if (e.key.toLowerCase() === 'v') {
      // ⌘V は基本 preventDefault しない。ブラウザの既定に任せて paste イベントを発生させ、
      // 実際の置き換えは paste リスナー（resolveDeletableBounds を共有する）に委ねる。
      // ただし選択が生エディタに触れる等で paste リスナーが処理しない場合はここで止めないと、
      // 行またぎ選択のままネイティブ paste が編集可能領域と描画 DOM にまたがって実行されてしまう
      const bounds = resolveOrBlock(e, resolveDeletableBounds);
      if (bounds === RESOLVE_FAILED) return;
      if (!bounds) e.preventDefault();
    }
    if (e.key.toLowerCase() === 'x') {
      // ⌘X は基本 preventDefault しない。ブラウザの既定に任せて cut イベントを発生させ、
      // 実際の削除は cut リスナー（buildSelectionCopyPayload と bounds を共有する）に委ねる。
      // ただし選択が生エディタに触れる等で cut リスナーが処理しない場合はここで止めないと、
      // 行またぎ選択のままネイティブ cut が編集可能領域と描画 DOM にまたがって実行されてしまう
      const resolvable = resolveOrBlock(e, resolveCutSelection);
      if (resolvable === RESOLVE_FAILED) return;
      if (!resolvable) e.preventDefault();
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    window.getSelection().removeAllRanges();
    return;
  }
  if (ARROW_KEYS.has(e.key) || NAV_KEYS.has(e.key)) {
    // Shift（選択拡張）・⌥（単語移動）付きはネイティブの選択操作に譲る。この免除は
    // ナビゲーション系キーだけに限る（Shift+Enter 等の破壊的キーまで免除しない）
    if (e.shiftKey || e.altKey) return;
    if (ARROW_KEYS.has(e.key)) {
      const target = resolveOrBlock(e, () => resolveCollapseTarget(e.key));
      if (target === RESOLVE_FAILED) return;
      if (target) {
        e.preventDefault();
        commitCollapse(target);
      }
    }
    return;
  }
  if (!e.shiftKey && !e.altKey && (e.key === 'Backspace' || e.key === 'Delete')) {
    const bounds = resolveOrBlock(e, resolveDeletableBounds);
    if (bounds === RESOLVE_FAILED) return;
    if (bounds) {
      e.preventDefault();
      e.stopPropagation();
      commitSelectionDeletion(bounds);
      return;
    }
    // 解決できない選択（生エディタに触れる等）は下の既定ブロックに委ねる
  }
  // 印字可能キー（Shift のみ許容）は行またぎ選択を置き換える
  if (isPrintableReplacementKey(e)) {
    const bounds = resolveOrBlock(e, resolveDeletableBounds);
    if (bounds === RESOLVE_FAILED) return;
    if (bounds) {
      e.preventDefault();
      e.stopPropagation();
      commitSelectionReplacement(bounds, e.key);
      return;
    }
    // 解決できない選択（生エディタに触れる等）は下の既定ブロックに委ねる
  }
  // preventDefault はブラウザ既定の編集を止めるだけで伝播は止まらない。
  // 生エディタ側の keydown（Enter の行分割・Tab のインデント）にも
  // 届かせないよう、ここで伝播ごと打ち切る。Shift+Enter・Shift+Tab・⌥Backspace 等、
  // 上のどの分岐にも当てはまらない Shift/⌥ 付きキーもここでブロックする。
  e.preventDefault();
  e.stopPropagation();
}, true);

// 行またぎ選択（および描画上の単一行選択）へのペーストは、選択を削除してからキャレット位置に
// 生エディタを開き、既存のペースト経路（pasteIntoEditor）へ合流させる。resolveDeletableBounds
// が解決できない（選択が無い・生エディタ内で完結する 等）ときは既定のペーストに任せる。
// 実アプリではネイティブ Edit メニューの Paste（PredefinedMenuItem::paste）が ⌘V を先取りする
// ため、keydown の ⌘V ガードを通らずに paste イベントが直接届く。解決できない選択のうち
// 行またぎのものは blockUnhandledCrossLineEdit で止める（cut と同じ穴を塞ぐ）
document.addEventListener('paste', async (e) => {
  let bounds;
  try {
    bounds = resolveDeletableBounds();
  } catch (err) {
    console.error('paste guard failed:', err);
    blockUnhandledCrossLineEdit(e);
    return;
  }
  if (!bounds) {
    blockUnhandledCrossLineEdit(e);
    return;
  }
  e.preventDefault();
  e.stopPropagation();

  const clipboardData = e.clipboardData;
  const text = clipboardData.getData('text/plain');
  const url = text.trim();

  // 選択テキスト + URL ペーストは生エディタ内の既存挙動（pasteIntoEditor）と揃え、
  // 削除と挿入を 1 回の splice で markdown link に置き換える。ラベルは選択が単一行のときだけ
  // bounds（resolveSelectionBounds が正規化した生 Markdown の範囲）から組み立てる。行またぎの
  // ラベルをそのまま埋めると、spliceSelectionRange が改行で複数行に分割してリンクが壊れるため、
  // その場合はリンク化せず素の URL 挿入（下の通常経路）に落とす
  const singleLineLabel = bounds.start.line === bounds.end.line
    ? getLines()[bounds.start.line].slice(bounds.start.col, bounds.end.col)
    : '';
  if (singleLineLabel && /^https?:\/\/\S+$/.test(url)) {
    commitSelectionReplacement(bounds, `[${singleLineLabel}](${url})`);
    return;
  }

  // 削除と（画像保存等の非同期処理を挟みうる）挿入を undo 1 手にまとめるため、
  // 一連の操作が終わるまで debounce の起動を保留し、最後にまとめて 1 回だけ発火させる
  holdSave = true;
  try {
    commitSelectionReplacement(bounds);
    const ed = activeEditor();
    if (!ed) {
      // 削除後のキャレット行が画像のみの行になった等で生エディタが開けない場合は、
      // プレーンテキストだけでも spliceSelectionRange の挿入テキストとして反映する
      // （無ければ削除だけで諦める）
      if (text) {
        const caret = { line: bounds.start.line, col: bounds.start.col };
        commitSelectionReplacement({ start: caret, end: caret }, text);
      }
      return;
    }
    await pasteIntoEditor(ed, clipboardData);
  } finally {
    holdSave = false;
    scheduleSave();
  }
}, true);

// ドロップは選択の置き換えに含めない（画像ドロップは行をまたぐ選択が残っていても許可する。
// 選択範囲への破壊的な書き込みではないため）
document.addEventListener('drop', (e) => {
  if (isFileDrag(e)) return;
  if (!selectionSpansLines() && !selectionSpansRawLines()) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

// ── Image Selection: keyboard ──────────────────────
// 画像選択中は生エディタが無い（フォーカス先の contenteditable が存在しない）ため、
// document レベルの keydown で拾う。selectedImage が無いときは即 return するので、
// 色ドットの矢印キーナビゲーションや ⌘W 等、他のキー処理とは衝突しない。
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
    enterLine(target, null);
  } finally {
    deletingImage = false;
  }
}

function deleteSelectedImage(key) {
  // 削除後のキャレット位置: 来た方向（押されたキー）の逆側優先。Backspace は前の行
  // （mergeLine の「前の行へ戻る」と同じ向き）。先頭行を消した場合は前が無いので
  // 先頭（0）に留まる（末尾へは飛ばさない）。Delete はそのまま同じ index
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
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    // 選択を解除して前の行の末尾へ（隣も画像のみの行なら enterLine が連続して選択状態にする）。
    // 端で行が無ければ選択を維持する（何もしない）
    if (selectedImage.line > 0) enterLine(selectedImage.line - 1, null);
    return;
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (selectedImage.line < getLines().length - 1) enterLine(selectedImage.line + 1, 0);
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
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

// ── Selection Copy (markdown-view) ─────────────────────────
// 描画部分（markdown-view）の選択から、対応する生 Markdown の範囲を求める。通常コピー
// （text/html + text/plain の同時セット）と「Markdown をコピー」（右クリックメニュー）が
// この写像を共有する。詳細は各関数のコメント参照（可視オフセット → raw オフセットの
// 純粋な変換自体は note-lines.js の visibleOffsetToRawOffset に持たせている）。

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
  const rawOffset = markerLen + visibleOffsetToRawOffset(inlineRaw, contentVisible, isEnd);
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
  // 生テキストまで巻き込む）。この切り詰めは削除範囲向けの補正であり、キャレットの畳み先
  // としてはユーザーが選択を始めた可視位置（マーカー直後）を使いたいため、切り詰め前の
  // startVisual をここで退避しておく（resolveCollapseTarget が使う。終了端の endVisual と対）
  const startVisual = { line: start.line, col: start.col };
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
  const endVisual = { line: end.line, col: end.col };
  if (
    end.line > start.line
    && !isCodeBlockLine(codeBlockRanges, end.line)
    && end.col === markerLength(lines[end.line])
  ) {
    end.col = 0;
  }

  const fenceExpanded = expandCodeBlockFences(start, end, lines, codeBlockRanges);
  const expanded = expandZeroVisibleLineSelection(fenceExpanded.start, fenceExpanded.end, lines);
  // フェンス拡張・退化選択の吸収で開始・終了行そのものが変わった場合、退避した可視位置は
  // 別の行を指しており使えない。そのときは削除向けの正規化済み start/end へフォールバックする
  const collapsedStartVisual = expanded.start.line === startVisual.line ? startVisual : expanded.start;
  const collapsedEndVisual = expanded.end.line === endVisual.line ? endVisual : expanded.end;
  return { ...expanded, startVisual: collapsedStartVisual, endVisual: collapsedEndVisual };
}

// ── Raw → DOM 位置の写像（resolveSelectionPoint の逆） ────
// 生エディタの境界を越える Shift+矢印・マウスドラッグで、生エディタの
// raw 位置を描画済み DOM の位置へ変換するのに使う。

/** 行 line の raw 列 col を、行頭マーカーを除いた「内容可視列」（inlineSegments 基準の
 * 可視文字オフセット）へ変換する。visibleOffsetFromRawOffset（note-lines.js）の DOM 版。 */
function contentVisibleColumn(line, col) {
  const lineText = getLines()[line] ?? '';
  const markerLen = markerLength(lineText);
  const inlineRaw = lineText.slice(markerLen);
  const rawInInline = Math.max(0, Math.min(col, lineText.length) - markerLen);
  return visibleOffsetFromRawOffset(inlineRaw, rawInInline);
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

/** document.caretRangeFromPoint の WebKit/Chromium 版と、Firefox 系の
 * caretPositionFromPoint 版を吸収する。どちらも無ければ null。 */
function caretRangeFromPointCompat(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
  }
  return null;
}

/**
 * 生エディタ内で Shift+矢印の keydown を受けたら呼ぶ共通のクランプ検出。e.preventDefault()
 * しない: 同一エディタ内での折返し行移動・行末/行頭までの拡張はまずネイティブに任せたい。
 * 現在の selection の anchor/focus（node, offset）を退避し、setTimeout(0) 後（ネイティブの
 * デフォルト動作が適用された後）に実際に動けたかを比較する。動けていれば（＝ネイティブの
 * 範囲内で処理できた）何もしない。動けていなければ（＝WebKit/Chromium が境界でクランプした）
 * onClamped を呼ぶ。フェンス等の複数行エディタでも同じ判定で足りる: 中間行への移動は
 * ネイティブ側で普通に進むので moved が true になり、変換は真の境界に達したときだけ発動する。
 */
function scheduleShiftArrowClampCheck(ed, onClamped) {
  const sel = window.getSelection();
  if (!sel.rangeCount) return;
  const before = {
    aNode: sel.anchorNode, aOff: sel.anchorOffset, fNode: sel.focusNode, fOff: sel.focusOffset,
  };
  // setTimeout(0) の間に後続のキー入力が割り込むと、その入力が選択を偶然 before と同じ位置へ
  // 戻すことがある（例: Shift+→ で 1 文字だけ拡張した直後に無修飾 ← で畳むと、畳んだ結果が
  // 拡張前と同じ位置に一致する）。その場合 moved が誤って false になり、実際には境界に
  // 達していないのに変換が発火してしまう。この keydown の通し番号を捕まえておき、発火時に
  // ズレていれば「後続入力に割り込まれた」とみなして何もしない
  const seq = editorKeySeq;
  setTimeout(() => {
    if (composing || !ed.isConnected || editorKeySeq !== seq) return;
    const moved = sel.anchorNode !== before.aNode || sel.anchorOffset !== before.aOff
      || sel.focusNode !== before.fNode || sel.focusOffset !== before.fOff;
    if (moved) return; // ネイティブが動けた（折返し行移動・行末までの拡張等）→ 何もしない
    onClamped();
  }, 0);
}

/**
 * 生エディタ内で Shift+ArrowDown/ArrowUp がエディタの境界（WebKit/Chromium が選択を
 * クランプする位置）に達したときに呼ぶ。次/前の描画行が無い、またはコードブロック
 * （対応スコープ外）のときは commitActive() を呼ばず何もしない（←→ 版と同じ判断。
 * commitActive() を先に呼んでしまうと、対象が無くて変換できない場合でも生エディタが
 * 閉じてしまい、フォーカスされた contenteditable が無くなって直後の入力が黙って
 * 捨てられる不具合になる）。対象があればエディタを commit して閉じ、描画 DOM 上に
 * 「選択 anchor（生 col を可視位置へ写像）→ 次/前の描画行の同等の可視列」の Range を張る。
 * commitActive の再描画で DOM が丸ごと差し替わるため、anchor/focus の生 (line, col) は
 * commit 前に読み、DOM 位置への写像は commit 後の新しい DOM に対して行う
 * （古い DOM ノードを参照する Range は再描画後に detached になり無効化する）。
 */
function convertEditorShiftArrowAcrossBoundary(ed, direction) {
  const sel = window.getSelection();
  if (!sel.rangeCount || activeStart == null) return;
  const anchorLineCol = editorPointToLineCol(ed, sel.anchorNode, sel.anchorOffset);
  const focusLineCol = editorPointToLineCol(ed, sel.focusNode, sel.focusOffset);
  const targetLine = direction === 'down' ? activeEnd + 1 : activeStart - 1;

  const lines = getLines();
  if (targetLine < 0 || targetLine >= lines.length) return; // 次/前の描画行が無ければ何もしない
  const targetBlock = findBlock(targetLine);
  if (!targetBlock || targetBlock.el.matches('.md-codeblock')) return; // コードブロックは対応スコープ外
  const contentVisible = contentVisibleColumn(focusLineCol.line, focusLineCol.col);

  commitActive();

  // targetBlock は commit 前（再描画前）の DOM を指しているため使い回さず、commit 後の
  // 新しい mdView に対して findBlock をやり直す（同じ行番号なら同じ行が見つかる）
  const freshTargetBlock = findBlock(targetLine);
  if (!freshTargetBlock) return;
  const focusPoint = domPointForContentVisible(freshTargetBlock.el, contentVisible);
  const anchorPoint = domPointForRawPosition(anchorLineCol.line, anchorLineCol.col);
  if (!anchorPoint || !focusPoint) return;

  const range = document.createRange();
  range.setStart(anchorPoint.node, anchorPoint.offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  sel.extend(focusPoint.node, focusPoint.offset);
}

/**
 * 生エディタ内で Shift+ArrowRight/ArrowLeft がエディタの境界（内容の末尾/先頭）に達したときに
 * 呼ぶ。次/前の描画行が無い、またはコードブロック（対応スコープ外）のときは commitActive() を
 * 呼ばず何もしない（↑↓ 版と同じ判断。理由も同じ: 先に commit すると変換できないのに生エディタが
 * 閉じ、直後の入力が黙って捨てられる）。対象があればエディタを commit して閉じ、描画 DOM 上に
 * 「選択 anchor（生 col を可視位置へ写像）→ 次/前の描画行の可視先頭/末尾」の Range を張る。
 */
function convertEditorShiftHorizontalAcrossBoundary(ed, direction) {
  const sel = window.getSelection();
  if (!sel.rangeCount || activeStart == null) return;
  const anchorLineCol = editorPointToLineCol(ed, sel.anchorNode, sel.anchorOffset);
  const targetLine = direction === 'right' ? activeEnd + 1 : activeStart - 1;
  const lines = getLines();
  if (targetLine < 0 || targetLine >= lines.length) return; // 次/前行が無ければ何もしない
  const targetBlock = findBlock(targetLine);
  if (!targetBlock || targetBlock.el.matches('.md-codeblock')) return; // コードブロックは対応スコープ外
  const targetLineText = lines[targetLine];
  const targetCol = direction === 'right' ? markerLength(targetLineText) : targetLineText.length;

  commitActive();

  // anchor/focus とも commit 後の新しい DOM に対して写像する（vertical 版と同じ理由）
  const anchorPoint = domPointForRawPosition(anchorLineCol.line, anchorLineCol.col);
  const focusPoint = domPointForRawPosition(targetLine, targetCol);
  if (!anchorPoint || !focusPoint) return;

  const range = document.createRange();
  range.setStart(anchorPoint.node, anchorPoint.offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  sel.extend(focusPoint.node, focusPoint.offset);
}

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
 * 選択範囲が生 Markdown の (行, 列) へ解決できない場合（例: 空の付箋のプレースホルダ表示
 * 「メモを入力…」は [data-line] を持たず、resolveSelectionPoint が対応する行を見つけられない）
 * は null を返す。この場合、呼び出し元は独自のコピー処理をせず既定のコピーに任せる
 * （解決できない DOM の断片を html・plain にそのまま流し込まないため）。
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
  const ed = activeEditor();
  if (ed && range.intersectsNode(ed)) return; // .raw-editor に触れる選択は既定の編集操作に任せる
  if (!mdView.contains(range.commonAncestorContainer)) return;
  const payload = buildSelectionCopyPayload(range);
  if (!payload) return; // 生 Markdown へ解決できない選択（プレースホルダ等）は既定のコピーに任せる
  e.preventDefault();
  e.clipboardData.setData('text/html', payload.html);
  e.clipboardData.setData('text/plain', payload.plain);
});

/** cut/paste イベントを処理できない選択が行をまたいでいたら既定の cut/paste を止める。実アプリ
 * ではネイティブ Edit メニューの Cut/Paste（PredefinedMenuItem::cut/paste）が ⌘X/⌘V を先取り
 * するため、keydown の ⌘X/⌘V ガードを通らずに cut/paste イベントが直接届く。ここで止めないと、
 * 行またぎ選択のままネイティブ cut/paste が編集可能領域と描画 DOM にまたがって実行され、
 * 管理外の DOM が壊れる。生エディタ内で完結する選択は spans が false なので既定のまま通る。 */
function blockUnhandledCrossLineEdit(e) {
  let spans = true; // 判定自体が例外を投げたときは安全側（ブロック）に倒す
  try {
    spans = selectionSpansLines() || selectionSpansRawLines();
  } catch (err) {
    console.error('cross-line edit guard failed:', err);
  }
  if (spans) {
    e.preventDefault();
    e.stopPropagation();
  }
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
    blockUnhandledCrossLineEdit(e);
    return;
  }
  if (!resolved) {
    // 解決できない選択のうち、生エディタ内で完結するものは既定のカットに任せ、
    // 行またぎのものはブロックする
    blockUnhandledCrossLineEdit(e);
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
  // IME 変換中に selectAllNote() が生エディタを閉じて確定前の入力を巻き込まないよう、
  // performUndo と同じガードで防ぐ
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
  // 生表示中の行や保留中のデバウンスを取りこぼさずに保存する。holdSave 中（ペーストの非同期
  // 処理待ち）は saveTimer が立っていないため、その有無に頼らず常に呼ぶ（同値なら history 側の
  // 同値ガードで無視されるだけなので、余分に呼んでも問題ない）
  snapshotContent();
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
      const ed = activeEditor();
      const touchesRawEditor = ed && range.intersectsNode(ed);
      if (!touchesRawEditor && mdView.contains(range.commonAncestorContainer)) {
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
// 生表示中の行を書き戻したうえでの付箋のソーステキスト
window.getRawContent = () => { snapshotContent(); return rawContent; };
window.enterLine = enterLine;
window.renderMarkdown = renderMarkdown;
window.changeZoom = changeZoom;
window.resetZoom = resetZoom;
window.performUndo = performUndo;
window.performRedo = performRedo;
window.resolveSelectionRange = resolveSelectionRange;
window.selectAllNote = selectAllNote;


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
