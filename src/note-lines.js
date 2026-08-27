// ── Note line helpers ────────────────────────────────────────
// 生 Markdown の行を扱う純粋関数。DOM にもエディタの状態にも触らないため、
// node の単体テストから直接呼べる。note.html では note.js より先に読み込む。

/** ブロック内の (行インデックス, 列) をエディタ先頭からのオフセットに変換する。 */
function blockOffset(blockLines, idx, col) {
  let offset = 0;
  for (let n = 0; n < idx; n++) offset += blockLines[n].length + 1;
  return offset + col;
}

/** 行頭マーカー（インデント・見出し・リスト・引用）の文字数。 */
function markerLength(line) {
  const indent = line.match(/^ */)[0].length;
  // 見出しはインデントが無いときだけ markdown.js が記号を剥がす
  const marker = indent === 0
    ? /^(#{1,3} |[-*] \[[ xX]\] |[-*] |> |\d+\. )/
    : /^([-*] \[[ xX]\] |[-*] |> |\d+\. )/;
  const m = line.slice(indent).match(marker);
  return indent + (m ? m[1].length : 0);
}

const LIST_PATTERNS = [
  { re: /^(- \[[ xX]\] )(.*)$/, prefix: () => '- [ ] ' },      // checkbox
  { re: /^([-*] )(?!\[[ xX]\] )(.*)$/, prefix: (m) => m[1] },   // bullet
  { re: /^(\d+)\. (.*)$/,      prefix: (m) => `${+m[1] + 1}. ` }, // ordered
  { re: /^(> )(.*)$/,          prefix: () => '> ' },           // blockquote
];

function stripIndent(line) {
  const indent = line.match(/^( *)/)[1];
  return { indent, stripped: line.slice(indent.length) };
}

/**
 * Return the prefix to auto-insert on the next line, or null if
 * the line is not a list/quote that should be continued.
 */
function getAutoPrefix(lineText) {
  const { indent, stripped } = stripIndent(lineText);
  for (const pat of LIST_PATTERNS) {
    const m = stripped.match(pat.re);
    if (m) return indent + pat.prefix(m);
  }
  return null;
}

/**
 * Return true if the line is an empty list item / blockquote
 * (i.e. prefix only, no content) that should be cancelled on Enter.
 */
function isEmptyListItem(lineText) {
  const { stripped } = stripIndent(lineText);
  for (const pat of LIST_PATTERNS) {
    const m = stripped.match(pat.re);
    if (!m) continue;
    const content = m[2];
    return !content.trim();
  }
  return false;
}

/** 打ち終えたチェックボックス記法。`- [ ] ` へ補完する対象を拾う。 */
const CHECKBOX_RE = /^([-*])\s?\[([xX]?)\]$/;

// `save_pasted_image`（Rust 側）が生成するパスの形状（`images/<uuid v4>.<ext>`）と対応させる。
// note.js の IMAGE_REL_PATH_RE と同じ形状だが、ここでは行全体が画像記法 1 個だけ
// （前後は空白のみ）であることまで見る必要があるため、行頭・行末アンカー込みで別に持つ。
const IMAGE_ONLY_LINE_RE = /^\s*!\[[^\]]*\]\(images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)\)\s*$/i;

/**
 * 行の内容が画像記法 1 個（`![alt|width](images/...)` 形式、前後は空白のみ）だけで
 * 構成されているか。true の行は生表示に入れず、選択状態で操作する。
 * テキストと画像が混在する行・複数画像を含む行・リモート URL の画像は対象外（false）。
 */
function isImageOnlyLine(lineText) {
  return IMAGE_ONLY_LINE_RE.test(lineText);
}

// ブラウザでは module が未定義なので、この行は classic script の読み込みに影響しない
if (typeof module !== 'undefined') {
  module.exports = {
    blockOffset, markerLength, getAutoPrefix, isEmptyListItem, CHECKBOX_RE, isImageOnlyLine,
  };
}
