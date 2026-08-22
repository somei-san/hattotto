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

let saveTimer = null;

// ── Editor State ──────────────────────────────────
// rawContent が唯一の真実。activeStart/activeEnd は今だけ生 Markdown で
// 表示しているブロックの行範囲（通常行では両者が同じ値）。
let rawContent = '';
let activeStart = null;
let activeEnd = null;
let composing = false;

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

  I18N.setLang(I18N.resolve(settings?.language));

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
  mdView.innerHTML = renderMarkdown(rawContent);
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

/** 行 lineIdx を生 Markdown に差し替え、col 列にキャレットを置く（col が null なら行末）。 */
function enterLine(lineIdx, col) {
  commitActive();
  // 変換中の行から離れると compositionend が来ないまま要素が消えるので、
  // フラグを持ち越さない（残ると次の行でキー操作が全て無視される）
  composing = false;
  const lines = getLines();
  const i = Math.max(0, Math.min(lineIdx, lines.length - 1));
  const block = findBlock(i);
  activeStart = block ? block.start : i;
  activeEnd = block ? block.end : i;

  const ed = document.createElement('div');
  ed.id = 'editor';
  ed.className = 'raw-editor' + (activeEnd > activeStart ? ' atomic' : '');
  ed.contentEditable = 'true';
  ed.setAttribute('aria-label', I18N.t('noteContentAriaLabel'));
  ed.textContent = lines.slice(activeStart, activeEnd + 1).join('\n');

  // 空の付箋はプレースホルダしか無いので、差し替え先が無い
  if (block) block.el.replaceWith(ed);
  else { mdView.innerHTML = ''; mdView.appendChild(ed); }

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

// mouseup で拾う（mousedown を潰すとドラッグでの範囲選択ができなくなるため）
mdView.addEventListener('mouseup', (e) => {
  if (e.target.closest('.raw-editor')) return;
  if (e.target.closest('a[data-url]') || e.target.closest('input[type="checkbox"]')) return;
  // 範囲選択したときは生表示に入らない（コピーの邪魔をしない）
  if (!window.getSelection().isCollapsed) return;

  const el = e.target.closest('[data-line]');
  const lines = getLines();
  if (!el) {
    enterLine(lines.length - 1, null); // 余白クリックは最終行の行末へ
    return;
  }
  // フェンスは行単位のマッピングを持たないので末尾に置く
  if (el.dataset.lineEnd != null) { enterLine(Number(el.dataset.lineEnd), null); return; }
  const lineIdx = Number(el.dataset.line);
  enterLine(lineIdx, rawColFromPoint(el, lines[lineIdx] ?? '', e));
});

mdView.addEventListener('click', (e) => {
  const link = e.target.closest('a[data-url]');
  if (!link) return;
  e.preventDefault();
  window.__TAURI__.shell.open(link.dataset.url);
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
}

let currentZoom = 100;

async function changeZoom(delta) {
  const next = Math.max(50, Math.min(200, currentZoom + delta * 10));
  if (next === currentZoom) return;
  currentZoom = next;
  applyZoom(next);
  fireInvoke('update_note_zoom', { id: noteId, zoom: next }, I18N.t('toastSaveFailed'));
}

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
function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let result = '';
  for (const node of doc.body.childNodes) {
    result += nodeToMd(node);
  }
  return result;
}

function nodeToMd(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = node.tagName.toLowerCase();
  // Strip script/style tags entirely — their text content is never useful
  if (tag === 'script' || tag === 'style') return '';
  const inner = Array.from(node.childNodes).map(nodeToMd).join('');
  switch (tag) {
    case 'a': {
      const href = node.getAttribute('href') || '';
      if (!href || /^javascript:/i.test(href)) return inner;
      return `[${inner.trim() || href}](${href})`;
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
    default:                   return inner;
  }
}

/** リッチテキストなら markdown に変換し、そうでなければプレーンテキストを返す。 */
function toMarkdown(text, html) {
  return html && /<(?:a|strong|b|em|i|del|s|code|h[1-3]|blockquote|[uo]l|li)\b/i.test(html)
    ? htmlToMarkdown(html)
    : text;
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

function onEditorPaste(e) {
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

  insertIntoEditor(ed, toMarkdown(text, e.clipboardData.getData('text/html')));
}

function onEditorDrop(e) {
  e.preventDefault();
  const ed = e.currentTarget;
  const text = e.dataTransfer.getData('text/plain');
  if (!text) return;
  // drop 位置ではなく現在のキャレット位置へ入れる
  insertIntoEditor(ed, toMarkdown(text, e.dataTransfer.getData('text/html')));
}

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
      if (line === activeStart) { e.preventDefault(); enterLine(activeStart - 1, col); }
      return;
    }
    if (e.key === 'ArrowDown') {
      const { line, col } = caretLineCol(ed);
      if (line === activeEnd && activeEnd < getLines().length - 1) {
        e.preventDefault();
        enterLine(activeEnd + 1, col);
      }
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && window.getSelection().isCollapsed) {
      if (mergeLine(ed, e.key === 'Backspace')) e.preventDefault();
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
    if (!selectionSpansLines()) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

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
  I18N.setLang(I18N.resolve(e.payload.language));
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
  invoke('show_context_menu', {
    id: noteId,
    isPinned: pinBtn.classList.contains('active'),
    currentColor: currentColor,
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
