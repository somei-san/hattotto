// ── Note line helpers ────────────────────────────────────────
// 付箋の編集で使う純粋関数（生 Markdown の行の解釈・画像記法の検証と無害化・書記素分割）。
// DOM にもエディタの状態にも触らないため、node の単体テストから直接呼べる。
// note.html では note.js より先に読み込む。

/** ブロック内の (行インデックス, 列) をエディタ先頭からのオフセットに変換する。 */
function blockOffset(blockLines, idx, col) {
  let offset = 0;
  for (let n = 0; n < idx; n++) offset += blockLines[n].length + 1;
  return offset + col;
}

/** 行頭マーカー（インデント・見出し・リスト・引用）の文字数。 */
function markerLength(line) {
  // `- - -`/`* * *` のような空白入りの水平線は、先頭だけ見るとリストマーカー（`- `/`* `）に
  // 見えてしまうが、classifyLine はこの形を hr と判定しており（HR_RE がリストの判定より先に
  // 検査される）hr 行にリストマーカーは無い。ここで hr を先に弾かないと、hr 行の raw 列と
  // 内容列の対応がリストマーカー分だけずれる
  if (classifyLine(line).type === 'hr') return 0;
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
// 同ファイルの IMAGE_REL_PATH_RE と同じ形状だが、ここでは行全体が画像記法 1 個だけ
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

/**
 * inlineRaw 中のコードスパン（`` `...` ``）の raw 範囲（マーカー込み、[start, end)）を列挙する。
 * markdown.js の CODE_RE（inlineMarkdown/inlineSegments と共有）を素の raw テキストへ直接
 * 適用するだけで、inlineSegments を経由しない。inlineSegments はコードスパンが他の装飾の
 * 内側に入れ子になっていると、外側の装飾 1 セグメント（例: `**`abc`**` → kind: 'bold',
 * charMap: null）にまとめてしまい `kind === 'code'` が表に出てこない。CODE_RE は raw の
 * バッククォート対を見るだけなので、そのような入れ子でも取りこぼさない。
 *
 * @param {string} inlineRaw マーカーを除いた raw 行の残り
 * @returns {{ start: number, end: number }[]}
 */
function scanCodeSpans(inlineRaw) {
  return [...inlineRaw.matchAll(CODE_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

/**
 * 選択 [start, end)（inlineRaw 上の raw オフセット）が、いずれかのコードスパンの一部にだけ
 * 触れている（スパンをちょうど丸ごと覆ってはいない）か。note.js の wrappableLineRange・
 * toggleEmphasisShortcut が、マーカー打鍵での周期送り・⌘B/⌘I トグルをコードスパンに対して
 * 対象外にするのに使う: コードスパンの中身はリテラルなテキストで、`` ` `` を打つと
 * `` `abc` `` の "b" を選んで打った場合に `` `a`b`c` `` とスパンが割れてしまう。
 *
 * 対象外にする条件は「重なりがあり、かつスパン全体を覆ってはいない」: 重なりが無ければ
 * 無関係、スパンをちょうど丸ごと覆う選択（[start, end) === [span.start, span.end)）は
 * 装飾自体をトグルする操作として引き続き対象にする（`` ` `` で解除できる）。スパンの片側
 * だけに触れる選択・スパンの内側（マーカー間）に完全に収まる選択・collapsed キャレット
 * （start === end）がマーカーの内側にある場合は、いずれもこの条件で対象外になる。
 *
 * @param {string} inlineRaw マーカーを除いた raw 行の残り
 * @param {number} start inlineRaw 上の raw オフセット
 * @param {number} end
 * @returns {boolean}
 */
function rangeTouchesCodeSpan(inlineRaw, start, end) {
  return scanCodeSpans(inlineRaw).some((span) => {
    const overlaps = start < span.end && end > span.start;
    if (!overlaps) return false;
    const covers = start <= span.start && end >= span.end;
    return !covers;
  });
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

// ── 選択範囲を記法で包む／トグルする ─────────────────────
// direct-edit（note.js の beforeinput ディスパッチャ）が、単一行の非 collapsed 選択に
// マーカー文字（`*`/`` ` ``/`~`）を打った・⌘B/⌘I を押したときに使う。行またぎ・フェンス
// 内容行の判定は findBlock（DOM 依存）が要るため note.js 側で行い、ここでは raw 行文字列と
// 列範囲だけを受け取る。
//
// 判定（選択の両側に何個マーカーが付いているか＝lead/trail）は resolveMarkerRun 1 つに集約し、
// ⌘B/⌘I（常に `*`）とマーカー打鍵（`*`/`` ` ``/`~`）の両方で共有する。書き換え方針だけが違う:
// ⌘B/⌘I は本数を「増減」する（nextEmphasisRun）のに対し、マーカー打鍵は「周期」を進める
// （nextMarkerCycle）。この 2 つの後段の違いは rewriteMarkerRun（区間の書き換え自体は共通）へ
// 渡す nextN の決め方の違いでしかない。

function markerRunBefore(text, pos, marker) {
  let n = 0;
  while (pos - n - 1 >= 0 && text[pos - n - 1] === marker) n++;
  return n;
}

function markerRunAfter(text, pos, marker) {
  let n = 0;
  while (pos + n < text.length && text[pos + n] === marker) n++;
  return n;
}

/**
 * 選択 [start, end) の「中身」と、その両側に既についている marker 文字の連続数（lead/trail）を
 * 求める。可視の装飾テキスト全体をドラッグした選択は raw 範囲がマーカー込みになる（例:
 * `**x**` を可視の "x" ごとドラッグすると raw 選択は `**x**` 全体）ため、まず選択そのものが
 * 両端とも marker の連続で始まり終わっていて内側に中身が残るかを見る。ただし選択が複数の装飾を
 * 覆っている場合（例: `**a** b **c**` 全体）は、両端の marker 連続を lead/trail として中身を
 * 取り出すと無関係な開き・閉じマーカーをペア扱いして記法を壊す（`a** b **c` のように中間の
 * マーカーが割れて残る）。中身候補に marker が 1 つも残らない（＝単一の装飾を丸ごと選択した）
 * ときだけこの内側判定を採用し、そうでなければ選択の外側に隣接する marker の連続を lead/trail
 * とする（マーカーの外側だけを選んだ通常の選択と同じ扱いになり、選択全体を新しい層で包むだけの
 * 安全な操作に倒れる）。
 *
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {string} marker 走査する 1 文字（`*`/`` ` ``/`~`）
 * @returns {{ contentStart: number, contentEnd: number, lead: number, trail: number }}
 */
function resolveMarkerRun(text, start, end, marker) {
  const slice = text.slice(start, end);
  let lead = 0;
  while (lead < slice.length && slice[lead] === marker) lead++;
  let trail = 0;
  while (trail < slice.length - lead && slice[slice.length - 1 - trail] === marker) trail++;
  const inner = slice.slice(lead, slice.length - trail);
  if (lead > 0 && trail > 0 && !inner.includes(marker)) {
    return { contentStart: start + lead, contentEnd: end - trail, lead, trail };
  }
  return {
    contentStart: start,
    contentEnd: end,
    lead: markerRunBefore(text, start, marker),
    trail: markerRunAfter(text, end, marker),
  };
}

/**
 * resolveMarkerRun の結果から、対称に扱える n = min(lead, trail) 本の区間だけを nextN 本の
 * marker で書き換える。lead/trail は非対称になりうる（例: 片側にだけ閉じていない marker が
 * 隣接している場合）ため、揃わなかった側の余り（lead - n または trail - n 本）はこの書き換え
 * 区間の外側にあり触れない。⌘B/⌘I のトグル・マーカー打鍵の周期送りの両方で共有する。
 *
 * @param {string} text
 * @param {{ contentStart: number, contentEnd: number, lead: number, trail: number }} run
 *   resolveMarkerRun の結果
 * @param {number} nextN 書き換え後の本数
 * @param {string} marker
 * @returns {{ text: string, contentStart: number, contentEnd: number }}
 */
function rewriteMarkerRun(text, run, nextN, marker) {
  const { contentStart, contentEnd, lead, trail } = run;
  const n = Math.min(lead, trail);
  const spanStart = contentStart - n;
  const spanEnd = contentEnd + n;
  const content = text.slice(contentStart, contentEnd);
  const newText = text.slice(0, spanStart)
    + marker.repeat(nextN) + content + marker.repeat(nextN)
    + text.slice(spanEnd);
  const newContentStart = spanStart + nextN;
  return { text: newText, contentStart: newContentStart, contentEnd: newContentStart + content.length };
}

/**
 * kind に応じてトグル対象にする `*` の本数を返す。⌘B は 2 個単位（2 個以上あれば外す、無ければ
 * 足す）、⌘I は 1 個単位（奇数なら外す、偶数なら足す）。
 *
 * @param {number} n resolveMarkerRun の lead/trail の小さい方（rewriteMarkerRun に渡すのと同じ n）
 * @param {'bold' | 'italic'} kind
 * @returns {number} 新しい本数
 */
function nextEmphasisRun(n, kind) {
  if (kind === 'bold') return n >= 2 ? n - 2 : n + 2;
  return n % 2 === 1 ? n - 1 : n + 1;
}

/**
 * 選択 [start, end) を挟む `*` をトグルする（⌘B/⌘I）。start === end（collapsed キャレット）でも
 * そのまま使える: resolveMarkerRun は中身が空でもキャレットの前後に隣接する `*` の連続を
 * lead/trail として拾うため、`**|**` へ ⌘B すると外れ、無地の位置なら `****` を挿入して
 * 中央にキャレットを置く（rewriteMarkerRun の content が空文字になるだけで同じ計算式で扱える）。
 *
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {'bold' | 'italic'} kind
 * @returns {{ text: string, contentStart: number, contentEnd: number }}
 */
function toggleEmphasisMarkers(text, start, end, kind) {
  const run = resolveMarkerRun(text, start, end, '*');
  const nextN = nextEmphasisRun(Math.min(run.lead, run.trail), kind);
  return rewriteMarkerRun(text, run, nextN, '*');
}

/**
 * 選択に同じマーカー文字を打鍵したときの「次の本数」。装飾の有無をトグルするのではなく、
 * マーカーごとに決まった周期を 1 打鍵ごとに進める（外側へ重ね続けない）:
 *   - `*`: 0 → 1 → 2 → 3 → 0（3 を超える本数は defensive に 0 へ戻す）
 *   - `` ` ``: 1 本以上あれば全部外す（0 へ）、無ければ 1 本で包む
 *   - `~`: 2 本以上なら 2 本外す（余りはそのまま残る）、それ未満（0 または 1）なら 2 本で包む。
 *     n=1（`~x~` のような、この機能では作られない状態）は「既存の 1 本の外側に足す」のではなく
 *     n 本ぶん丸ごと新しい 2 本に置き換わる（rewriteMarkerRun が対称本数 n を書き換え区間その
 *     ものにするため、余りという概念が生じない）
 *
 * @param {number} n resolveMarkerRun の lead/trail の小さい方
 * @param {string} marker `*`/`` ` ``/`~`
 * @returns {number} 新しい本数
 */
function nextMarkerCycle(n, marker) {
  if (marker === '*') return n >= 3 ? 0 : n + 1;
  if (marker === '`') return n >= 1 ? 0 : 1;
  return n >= 2 ? n - 2 : 2; // '~'
}

/**
 * 選択 [start, end) に marker を打鍵したときの周期送りを 1 回適用する（note.js の
 * cycleSelectionMarker から呼ぶ）。
 *
 * @param {string} text
 * @param {number} start
 * @param {number} end
 * @param {string} marker `*`/`` ` ``/`~`
 * @returns {{ text: string, contentStart: number, contentEnd: number }}
 */
function cycleMarkerRun(text, start, end, marker) {
  const run = resolveMarkerRun(text, start, end, marker);
  const nextN = nextMarkerCycle(Math.min(run.lead, run.trail), marker);
  return rewriteMarkerRun(text, run, nextN, marker);
}

// ── 画像記法 ──────────────────────────────────────────────
// 画像パスの検証・alt/URL の無害化・data: URI のデコード・画像幅の書き換え。

// `save_pasted_image`（Rust 側）が生成するパスの形状（`images/<uuid v4>.<ext>`）とだけ一致させる。
// asset protocol の scope（$APPDATA/images/**/*）を信じきらず、`images/../notes.json` のような
// 細工パスを resolveImageSrc で asset URL に変換してしまわないための最終防衛ライン。
const IMAGE_REL_PATH_RE = /^images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)$/i;
function isValidImageRelPath(path) {
  return typeof path === 'string' && IMAGE_REL_PATH_RE.test(path);
}

/**
 * 行 line の Markdown 記法のうち、relSrc と一致する occurrence 番目（0始まり）の画像記法だけ
 * `|width` を追加・置換する。markdown.js の inlineMarkdown が code を先に保護してから画像記法を
 * 解釈するのと同じ解釈で、コードスパン内の `![alt](src)` は画像記法として数えない（occurrence の
 * 定義を DOM 側＝実際に <img> として描画されるものと一致させる）。
 */
function rewriteImageWidth(line, relSrc, width, occurrence) {
  let seen = -1;
  return line.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, alt, src, offset) => {
    if (rangeTouchesCodeSpan(line, offset, offset + 1)) return whole;
    if (src !== relSrc) return whole;
    seen++;
    if (seen !== occurrence) return whole;
    const base = alt.replace(/\|\d+$/, '');
    return `![${base}|${width}](${src})`;
  });
}

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

// Rust 側 save_pasted_image の上限（src-tauri/src/persistence.rs の MAX_IMAGE_BYTES）と揃える。
// atob() でのデコードは全体をメモリ上に展開するため、送る前に base64 の文字数から概算して弾く。
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DATA_URI_TOO_LARGE = Symbol('data-uri-too-large');

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

// ── 書記素クラスタ ────────────────────────────────────────

const GRAPHEME_SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter() : null;

/** 文字列 s の書記素クラスタ列。Intl.Segmenter が無い環境ではコードポイント単位に分割する
 * （結合文字や ZWJ 列は分かれる）。 */
function graphemesOf(s) {
  if (GRAPHEME_SEGMENTER) return [...GRAPHEME_SEGMENTER.segment(s)].map((g) => g.segment);
  return [...s];
}

// ブラウザでは module が未定義なので、この行は classic script の読み込みに影響しない
if (typeof module !== 'undefined') {
  module.exports = {
    blockOffset, markerLength, getAutoPrefix, isEmptyListItem, CHECKBOX_RE, isImageOnlyLine,
    isCheckboxLine, visibleOffsetToRawOffset, visibleOffsetFromRawOffset, revealTargetAt,
    scanCodeSpans, rangeTouchesCodeSpan,
    inlineDecorationKeepRanges, deletionSurvivingFragment, widenRangeForEmptiedDecorations,
    resolveMarkerRun, toggleEmphasisMarkers, cycleMarkerRun,
    isValidImageRelPath, rewriteImageWidth,
    sanitizeAltText, sanitizeImageAlt, sanitizeUrl, isDataUri,
    MAX_IMAGE_BYTES, DATA_URI_TOO_LARGE, decodeDataUri,
    graphemesOf,
  };
}
