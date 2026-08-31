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

/** markdown.js のチェックボックス行判定（`- [ ] `/`- [x] `、インデント込み）と同じ形状。
 * チェックボックス自身は contenteditable="false" の空要素なので、矢印キーでの行またぎ
 * ナビゲーション（note.js）がこの行の内容先頭を素通りさせる対象を見分けるのに使う。 */
const CHECKBOX_LINE_RE = /^ *[-*] \[[ xX]\] /;
function isCheckboxLine(lineText) {
  return CHECKBOX_LINE_RE.test(lineText);
}

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

/**
 * インライン部（行頭マーカーを除いた raw 行の残り）の可視文字オフセットを raw オフセットへ
 * 変換する。markdown-view の DOM 選択（可視テキスト基準）から生 Markdown の範囲を求めるのに使う
 * （note.js の resolveSelectionPoint が、行頭マーカー分を除いた残りをここへ渡す）。
 *
 * inlineSegments(inlineRaw) の各セグメントを可視文字数で消費しながら探し、visibleOffset が
 * 属するセグメント内の位置を raw オフセットへ写す。プレーンセグメント（装飾を伴わない素の
 * テキスト）は可視文字と raw 文字が 1:1 対応するのでそのまま足す。装飾セグメント（**bold** 等）
 * は charMap があれば内部の可視文字位置も raw へ厳密対応する（両端の境界は charMap の有無に
 * 関わらず常に srcStart/srcEnd）。charMap を持たないセグメント（画像・ネストした装飾）の内部に
 * 境界が落ちた場合は、記法を欠けさせないようセグメント全体を含める側（開始端なら srcStart、
 * 終了端なら srcEnd）に丸める。
 *
 * @param {string} inlineRaw マーカーを除いた raw 行の残り
 * @param {number} visibleOffset インライン部の可視文字数オフセット
 * @param {boolean} isEnd 選択の終了端かどうか（charMap を持たないセグメント内部への丸め方向に使う）
 * @returns {number} inlineRaw 上のオフセット
 */
function visibleOffsetToRawOffset(inlineRaw, visibleOffset, isEnd) {
  const segments = inlineSegments(inlineRaw);
  let consumed = 0;
  for (const seg of segments) {
    const segLen = seg.visibleText.length;
    if (visibleOffset > consumed + segLen) {
      consumed += segLen;
      continue;
    }
    const within = visibleOffset - consumed;
    // charMap がある装飾セグメントは境界規約（両端は srcStart/srcEnd、内部は charMap）で厳密に解決する。
    // isEnd はもう使わない: 内部の丸め方向という役割は charMap の厳密対応に置き換わった
    if (seg.charMap) {
      if (within <= 0) return seg.srcStart;
      if (within >= segLen) return seg.srcEnd;
      return seg.charMap.srcStart + within;
    }
    const isPlain = seg.visibleText === inlineRaw.slice(seg.srcStart, seg.srcEnd);
    if (isPlain) return seg.srcStart + within;
    if (within <= 0) return seg.srcStart;
    if (within >= segLen) return seg.srcEnd;
    return isEnd ? seg.srcEnd : seg.srcStart;
  }
  return inlineRaw.length;
}

/**
 * visibleOffsetToRawOffset の逆。インライン部の raw オフセットを可視文字オフセットへ変換する。
 * 生エディタのキャレット位置（raw）を描画 DOM 上の位置（可視）へ写像するのに使う
 * （note.js の contentVisibleColumn が、行頭マーカー分を除いた残りをここへ渡す）。
 *
 * inlineSegments(inlineRaw) の各セグメントを raw 文字数で消費しながら探し、rawOffset が
 * 属するセグメント内の位置を可視オフセットへ写す。プレーンセグメントは 1:1 対応でそのまま足す。
 * 装飾セグメント（**bold** 等）は charMap があれば中身の raw 範囲に落ちた rawOffset を厳密対応し、
 * マーカー上に落ちた場合は同じ側の可視境界へ寄せる。charMap が無いセグメントでマーカー上に落ちた
 * 場合は、セグメント中央を境に近い側の可視境界（手前/奥）へ丸める
 * （キャレットは記法の内部を指せないため、見た目上の直近の位置に寄せる）。
 *
 * @param {string} inlineRaw マーカーを除いた raw 行の残り
 * @param {number} rawOffset inlineRaw 上の raw オフセット
 * @returns {number} インライン部の可視文字オフセット
 */
function visibleOffsetFromRawOffset(inlineRaw, rawOffset) {
  const segments = inlineSegments(inlineRaw);
  let consumed = 0; // ここまでの可視文字数の累計
  for (const seg of segments) {
    const segLen = seg.visibleText.length;
    if (rawOffset > seg.srcEnd) {
      consumed += segLen;
      continue;
    }
    if (rawOffset <= seg.srcStart) return consumed;
    // charMap がある場合は中身の raw 範囲を厳密対応し、マーカー上に落ちた raw 位置は
    // 同じ側の可視境界（開きマーカー → セグメント先頭、閉じマーカー → セグメント末尾）へ寄せる。
    // 中央値丸めに落とすと raw を右へ進めたとき可視位置が戻る（単調性が壊れる）ため使わない
    if (seg.charMap) {
      const cs = seg.charMap.srcStart;
      const ce = cs + seg.charMap.len;
      if (rawOffset <= cs) return consumed;
      if (rawOffset >= ce) return consumed + segLen;
      return consumed + (rawOffset - cs);
    }
    const isPlain = seg.visibleText === inlineRaw.slice(seg.srcStart, seg.srcEnd);
    if (isPlain) return consumed + (rawOffset - seg.srcStart);
    const mid = (seg.srcStart + seg.srcEnd) / 2;
    return rawOffset < mid ? consumed : consumed + segLen;
  }
  return consumed;
}

// ブラウザでは module が未定義なので、この行は classic script の読み込みに影響しない
if (typeof module !== 'undefined') {
  module.exports = {
    blockOffset, markerLength, getAutoPrefix, isEmptyListItem, CHECKBOX_RE, isImageOnlyLine,
    isCheckboxLine, visibleOffsetToRawOffset, visibleOffsetFromRawOffset,
  };
}
