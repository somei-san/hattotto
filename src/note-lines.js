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
 * @param {{start: number, end: number} | null} [reveal] インライン生表示で該当セグメントを生 raw
 *   表示しているときの範囲（inlineSegments の reveal 引数と同じ）。可視 = raw の 1:1 になる
 * @returns {number} inlineRaw 上のオフセット
 */
function visibleOffsetToRawOffset(inlineRaw, visibleOffset, isEnd, reveal) {
  const segments = inlineSegments(inlineRaw, reveal);
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
 * @param {{start: number, end: number} | null} [reveal] visibleOffsetToRawOffset と同じ
 * @returns {number} インライン部の可視文字オフセット
 */
function visibleOffsetFromRawOffset(inlineRaw, rawOffset, reveal) {
  const segments = inlineSegments(inlineRaw, reveal);
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

/**
 * インライン部の raw オフセット col が、インライン装飾（code/bold/italic/del/link）の可視先頭〜
 * 可視末尾（境界含む）に触れているとき、reveal 対象のセグメント raw 範囲 { start, end } を返す
 * （note.js の selectionchange ハンドラが、キャレット位置からインライン生表示の対象を決めるのに使う）。
 * プレーンテキスト・画像・裸URLの上、あるいはどの装飾にも触れていなければ null。
 * 境界で 2 つのセグメントが接する場合は raw 上で手前（左）のセグメントを優先する
 * （装飾の可視末尾ちょうどと次のセグメントの可視先頭ちょうどが同じ raw オフセットを指すため）。
 *
 * @param {string} inlineRaw マーカーを除いた raw 行の残り
 * @param {number} col inlineRaw 上の raw オフセット
 * @returns {{start: number, end: number} | null}
 */
function revealTargetAt(inlineRaw, col) {
  const segments = inlineSegments(inlineRaw);
  for (const seg of segments) {
    if (col < seg.srcStart || col > seg.srcEnd) continue;
    if (!isRevealableKind(seg.kind)) continue;
    return { start: seg.srcStart, end: seg.srcEnd };
  }
  return null;
}

// ── 選択削除・置換のマーカー保存 ─────────────────────────
// 装飾のマーカー（`**`・`` ` ``・`~~`・`[`〜`](url)`）と内容は不可分な 1 つの記法で、選択が
// 内容の一部だけに触れている（装飾全体を覆っていない）ときにマーカーごと削除すると、開き・
// 閉じの片方だけが残ってリテラル露出する（例: `**bold**` の "b" だけ選んで削除すると
// `**b` が消えて `old**` が壊れた記法として残る）。commitSelectionReplacement（note.js）は
// これらの関数で「削除範囲のうち装飾のマーカー部分だけを避ける」よう組み立て直す。

/**
 * [lo, hi) と重なる装飾セグメント（charMap を持つもの＝太字/斜字/取り消し線/インラインコード/
 * リンク）のうち、内容(charMap の範囲)全体までは覆っていないもの（部分選択）について、
 * 開き・閉じマーカーのうち [lo, hi) に入っている部分を「保存区間」として返す。内容全体が
 * [lo, hi) に覆われているセグメントはマーカーごと削除してよいので含めない。charMap を持たない
 * セグメント（画像・ネストした装飾等）は対象外（従来どおり丸ごと削除される）。
 *
 * reveal（該当行の revealState）を渡すと、その範囲に一致するセグメントは inlineSegments が
 * マーカー込みの raw 全体を 1 つの charMap（可視 = raw が 1:1）として返す（srcStart===charMap の
 * 開始、srcEnd===charMap の終了になる）ため、開き・閉じマーカーの区間が幅 0 になり保存対象から
 * 自然に外れる。インライン生表示中はマーカー自体が見えている生テキストで、それを直接削除するのは
 * 装飾解除そのもの（reveal の仕様）であり、部分選択のマーカー保存とは別の操作だからそこは避けない。
 *
 * @param {string} inlineRaw マーカーを除いた raw 行の残り
 * @param {number} lo [lo, hi) の開始（inlineRaw 上のオフセット）
 * @param {number} hi [lo, hi) の終了
 * @param {{start: number, end: number} | null} [reveal] インライン生表示中の範囲（inlineSegments 参照）
 * @returns {[number, number][]} 保存する raw 区間（開始位置の昇順、inlineRaw 上のオフセット）
 */
function inlineDecorationKeepRanges(inlineRaw, lo, hi, reveal) {
  const segments = inlineSegments(inlineRaw, reveal);
  const keep = [];
  for (const seg of segments) {
    if (!seg.charMap) continue;
    if (seg.srcEnd <= lo || seg.srcStart >= hi) continue; // [lo, hi) と重ならない
    if (lo <= seg.srcStart && hi >= seg.srcEnd) continue; // 装飾全体を覆う → マーカーごと削除してよい
    const cs = seg.charMap.srcStart;
    const ce = cs + seg.charMap.len;
    const openStart = Math.max(seg.srcStart, lo);
    const openEnd = Math.min(cs, hi);
    if (openEnd > openStart) keep.push([openStart, openEnd]);
    const closeStart = Math.max(ce, lo);
    const closeEnd = Math.min(seg.srcEnd, hi);
    if (closeEnd > closeStart) keep.push([closeStart, closeEnd]);
  }
  return keep;
}

/**
 * lineText の [lo, hi) を、部分的に覆われた装飾のマーカーを保存しながら削除した結果を返す。
 * text は [lo, hi) の生き残り（inlineDecorationKeepRanges の保存区間を連結したもの。それ以外は
 * 削除される）。insertOffset は text 内で最初に実際の削除が起きた位置で、置換テキストは
 * ここへ挿し込む（commitSelectionReplacement の「削除範囲の位置に挿入する」という既存の
 * 意味論を、マーカー保存後も保つ）。[0, lo) と [hi, lineText.length) はこの関数の対象外
 * （呼び出し元がそのまま残す）。
 *
 * markerLen（行頭マーカー長）は既定で markerLength(lineText) を使うが、フェンス内容行は
 * 呼び出し元（note.js の lineStartColumn）から明示的に 0 を渡すこと。フェンス内容行の raw は
 * 可視テキストそのもの（先頭の空白もインデントではなく実コードの一部）で、markerLength を
 * そのまま適用すると空白をマーカー扱いして削除範囲がずれる。
 *
 * @param {string} lineText
 * @param {number} lo raw 列（行頭マーカー込みのオフセット）
 * @param {number} hi
 * @param {number} [markerLen] 行頭マーカー長。省略時は markerLength(lineText)
 * @param {{start: number, end: number} | null} [reveal] インライン生表示中の範囲
 *   （inlineDecorationKeepRanges 参照）
 * @returns {{ text: string, insertOffset: number }}
 */
function deletionSurvivingFragment(lineText, lo, hi, markerLen = markerLength(lineText), reveal) {
  const inlineRaw = lineText.slice(markerLen);
  const inlineLo = Math.max(0, lo - markerLen);
  const inlineHi = Math.max(0, hi - markerLen);
  const keep = inlineDecorationKeepRanges(inlineRaw, inlineLo, inlineHi, reveal);

  let text = '';
  let insertOffset = null;
  let cursor = inlineLo;
  for (const [s, e] of keep) {
    if (s > cursor && insertOffset === null) insertOffset = text.length;
    text += inlineRaw.slice(s, e);
    cursor = e;
  }
  if (insertOffset === null) insertOffset = text.length;
  return { text, insertOffset };
}

/**
 * [lo, hi) を、内容(charMap の範囲)が丸ごと [lo, hi) に収まってしまう装飾のマーカーごと含むよう
 * 広げる。マーカーと内容は不可分な 1 つの記法なので、内容が全部消えるならマーカーも同じ削除に
 * 含めて装飾ごと消す（正規化を別の splice に分けると undo が 2 手に割れるため、削除範囲を
 * 広げる形で同じ splice に含める。分けないと空になった `` **** `` 等が raw にリテラルとして
 * 残ってしまう＝閉じられない記法として描画される）。リンクはラベルが空でも URL が実体として
 * 残るため対象外（`[](url)` は正常な状態）。
 *
 * inlineDecorationKeepRanges と異なり reveal を受け取らず、常に通常（非 reveal）のセグメント
 * 構造で内容の範囲を判定する。1 文字だけの内容（例: `**x**`）は、インライン生表示中の装飾
 * すべてに対して選択が及ぶあいだキャレットが必ず reveal 対象になる（selectionchange の
 * 不変条件）ため、この関数の呼び出し元（deleteAdjacentVisibleChar 経由）は「内容の 1 文字を
 * 消す」操作もほぼ常に reveal 中に発生する。reveal 中のセグメントは charMap が raw 全体
 * （マーカー込み）を指すため、reveal を渡すと「内容」がマーカーごと raw 全体になってしまい、
 * 本来の内容（例の "x"）だけが消えたケースを検出できなくなる。マーカー文字そのものを直接
 * 消す編集（inlineDecorationKeepRanges 側で reveal 対応する対象）とは区別されるべき操作
 * なので、ここでは reveal に関わらず常に「内容が全部消えたか」を素の raw 構造で判定する。
 *
 * markerLen の既定・フェンス内容行での扱いは deletionSurvivingFragment と同じ
 * （呼び出し元から lineStartColumn を明示的に渡すこと）。
 *
 * lo・hi がマーカーの内部（lo < markerLen または hi < markerLen）を指す場合、inline 座標
 * （lo - markerLen 等）は負になりうるが、あえてクランプしない。クランプすると「マーカー未満
 * だった」という情報が失われ、raw 座標へ戻すときに常に markerLen そのものへ丸め込まれてしまう
 * （返り値が入力範囲を包含しない＝widen のはずが縮む）。segments の cs/ce/srcStart/srcEnd は
 * 常に 0 以上なので、負の inline 座標との比較（`seg.srcStart < inlineLo` 等）は「入力がそもそも
 * マーカー側まで達している」を正しく素通りし、返り値は常に入力 [lo, hi) を包含する
 * （inlineLo は初期値からしか減らず、inlineHi は初期値からしか増えないため）。
 *
 * @param {string} lineText
 * @param {number} lo raw 列
 * @param {number} hi
 * @param {number} [markerLen] 行頭マーカー長。省略時は markerLength(lineText)
 * @returns {{ lo: number, hi: number }}
 */
function widenRangeForEmptiedDecorations(lineText, lo, hi, markerLen = markerLength(lineText)) {
  const inlineRaw = lineText.slice(markerLen);
  let inlineLo = lo - markerLen;
  let inlineHi = hi - markerLen;
  const segments = inlineSegments(inlineRaw);
  let changed = true;
  while (changed) {
    changed = false;
    for (const seg of segments) {
      if (!seg.charMap || seg.kind === 'link') continue;
      const cs = seg.charMap.srcStart;
      const ce = cs + seg.charMap.len;
      const contentGone = cs >= inlineLo && ce <= inlineHi;
      const outerCovered = seg.srcStart >= inlineLo && seg.srcEnd <= inlineHi;
      if (!contentGone || outerCovered) continue;
      if (seg.srcStart < inlineLo) { inlineLo = seg.srcStart; changed = true; }
      if (seg.srcEnd > inlineHi) { inlineHi = seg.srcEnd; changed = true; }
    }
  }
  return { lo: inlineLo + markerLen, hi: inlineHi + markerLen };
}

// ブラウザでは module が未定義なので、この行は classic script の読み込みに影響しない
if (typeof module !== 'undefined') {
  module.exports = {
    blockOffset, markerLength, getAutoPrefix, isEmptyListItem, CHECKBOX_RE, isImageOnlyLine,
    isCheckboxLine, visibleOffsetToRawOffset, visibleOffsetFromRawOffset, revealTargetAt,
    inlineDecorationKeepRanges, deletionSurvivingFragment, widenRangeForEmptiedDecorations,
  };
}
