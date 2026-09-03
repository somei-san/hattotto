// ── Markdown rendering utilities ─────────────────────────────
// Shared by note.html (preview) and tests (via window.renderMarkdown).
// Depends on escapeHtml() from utils.js (loaded before this script).
/* exported renderMarkdown */

// Note: inlineMarkdown receives escapeHtml-processed strings.
// This is intentional — HTML entities (e.g. &amp;) are treated as plain text
// within Markdown syntax, and code blocks store the escaped form as-is,
// avoiding double-escaping when placed inside <code> tags.

// escapeHtml() (utils.js) only escapes & < > — safe for element content, but an
// attribute value (href, data-url, img alt/src) also needs " and ' escaped, or
// a crafted markdown source (e.g. `!["  onerror=alert(1) x="](images/a.png)`)
// can break out of the attribute and inject event handlers.
function escapeAttr(s) {
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Obsidian 方式の表示幅指定（`![alt|300](...)`）の下限・上限。範囲外・0 は指定なし扱いにする。
const IMAGE_WIDTH_MIN = 40;
const IMAGE_WIDTH_MAX = 2000;

/**
 * alt 末尾の `|数字` を表示幅として分離する。末尾セグメントが数字のみのときだけ幅指定とみなし、
 * `![a|b]` のような非数値サフィックスは alt をそのまま返す（幅なし）。
 */
function parseImageAlt(altRaw) {
  const m = altRaw.match(/^(.*)\|(\d+)$/);
  if (!m) return { alt: altRaw, width: null };
  const n = parseInt(m[2], 10);
  const width = (n >= IMAGE_WIDTH_MIN && n <= IMAGE_WIDTH_MAX) ? n : null;
  return { alt: m[1], width };
}

// ── インライン記法の置換チェーン（inlineMarkdown と inlineSegments で共有） ──────
// 正規表現と、コールバックが複雑なもの（画像・リンク・裸URL）のビルダー関数を共有し、
// 2 つの経路で記法の解釈がずれないようにする。
const CODE_RE = /`([^`]+)`/g;
const BOLD_RE = /\*\*(.+?)\*\*/g;
const ITALIC_RE = /\*([^*]+)\*/g;
const DEL_RE = /~~([^~]+)~~/g;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
// ラベルは IMAGE_RE と同じく空を許す（`[^\]]*`）。空マーカー正規化（note-lines.js の
// widenRangeForEmptiedDecorations）はリンクのラベルが空になっても URL が実体として残るため
// マーカーごと消さない仕様（`[](url)` のまま）で、ラベル必須（`+`）のままだとこの raw が
// リンクとして解決できず、代わりに BAREURL_RE が URL 側の `)` まで巻き込んでリンク化してしまう
const LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
const BAREURL_RE = /((?:^|[^"=]))((https?:\/\/)[^\s<]+)/g;
// eslint-disable-next-line no-control-regex -- \x00 is the placeholder marker
const CODE_RESTORE_RE = /\x00CODE(\d+)\x00/g;

// ![alt](src) → <img>（link の正規表現より先。`!` プレフィックスで区別する）
// data-rel-src は resolve 前の相対パス。ダブルクリック・右クリックのハンドラは
// asset URL 化された src ではなくこちらから元の相対パスを取り出す
function buildImageHtml(altRaw, src) {
  const resolved = (typeof window !== 'undefined' && typeof window.resolveImageSrc === 'function')
    ? window.resolveImageSrc(src)
    : src;
  // title はダブルクリックで開けることを伝えるアフォーダンス（クリックしても反応が無いため）
  const hint = (typeof window !== 'undefined' && window.I18N) ? window.I18N.t('imageOpenHint') : 'ダブルクリックで開く';
  const { alt, width } = parseImageAlt(altRaw);
  const widthAttr = width != null ? ` width="${width}"` : '';
  return `<img alt="${escapeAttr(alt)}" src="${escapeAttr(resolved)}" data-rel-src="${escapeAttr(src)}" title="${escapeAttr(hint)}"${widthAttr}>`;
}
function buildLinkHtml(text, url) {
  return `<a href="${escapeAttr(url)}" data-url="${escapeAttr(url)}">${text}</a>`;
}
function buildBareUrlHtml(pre, url) {
  return `${pre}<a href="${escapeAttr(url)}" data-url="${escapeAttr(url)}">${url}</a>`;
}
function buildStrongHtml(inner) {
  return `<strong>${inner}</strong>`;
}
function buildEmHtml(inner) {
  return `<em>${inner}</em>`;
}
function buildDelHtml(inner) {
  return `<del>${inner}</del>`;
}

// ── inlineSegments 用の content range（applyInlineStep の contentRange 引数） ──────
// 対称マーカーの装飾・リンクラベル・裸URLは、出力の可視部分がマッチの部分文字列そのままの
// コピーなので、その範囲（現在の state.text 上の [start, end)）を返す。画像のように
// alt/src が属性にしか現れない記法は contentRange を渡さない（常に非トラッキング）
function codeContentRange(m) { return { start: m.index + 1, end: m.index + 1 + m[1].length }; }
function boldContentRange(m) { return { start: m.index + 2, end: m.index + 2 + m[1].length }; }
function italicContentRange(m) { return { start: m.index + 1, end: m.index + 1 + m[1].length }; }
function delContentRange(m) { return { start: m.index + 2, end: m.index + 2 + m[1].length }; }
function linkContentRange(m) { return { start: m.index + 1, end: m.index + 1 + m[1].length }; }
// 裸URLは pre + url がそのまま出力の可視部分になる（マーカーで包まれない）ので範囲はマッチ全体
function bareUrlContentRange(m) { return { start: m.index, end: m.index + m[0].length }; }

/**
 * escapeHtml 済みの文字列からインライン装飾を解決する。note.js の描画パス本体で、
 * 呼び出し頻度が高いためオフセット追跡は一切行わない素の逐次置換チェーン。
 */
function inlineMarkdown(escaped) {
  // `code` → placeholder (protect from bold/italic/strikethrough)
  const codeBlocks = [];
  escaped = escaped.replace(CODE_RE, (_, c) => {
    codeBlocks.push(c);
    return '\x00CODE' + (codeBlocks.length - 1) + '\x00';
  });
  // **bold** → <strong>
  escaped = escaped.replace(BOLD_RE, (_, inner) => buildStrongHtml(inner));
  // *italic* → <em> (after bold to avoid conflict)
  escaped = escaped.replace(ITALIC_RE, (_, inner) => buildEmHtml(inner));
  // ~~strikethrough~~ → <del>
  escaped = escaped.replace(DEL_RE, (_, inner) => buildDelHtml(inner));
  escaped = escaped.replace(IMAGE_RE, (_, altRaw, src) => buildImageHtml(altRaw, src));
  // [text](url) → <a>
  escaped = escaped.replace(LINK_RE, (_, text, url) => buildLinkHtml(text, url));
  // Bare URLs → <a> (skip URLs already inside an <a> tag)
  escaped = escaped.replace(BAREURL_RE, (_, pre, url) => buildBareUrlHtml(pre, url));
  // Restore code blocks
  escaped = escaped.replace(CODE_RESTORE_RE, (_, i) => '<code>' + codeBlocks[i] + '</code>');
  return escaped;
}

// ── inlineSegments の内部実装 ─────────────────────────────────
// inlineMarkdown と同じ置換チェーンを、raw（escapeHtml 前）テキストの各文字が
// 出力のどこに由来するかを追跡しながら適用し、セグメント列を組み立てる。
// 由来の追跡は文字単位の２つの配列で行う:
//   - grp[i]: 文字 i が属する group の id。まだ何の記法にも巻き込まれていない
//     素のテキストなら -1（「plain」）
//   - srcIdx[i]: grp[i] === -1 のときだけ有効。文字 i が由来する raw 上の位置
// grp !== -1 の文字（装飾・画像・リンク等で生成された文字）の src 範囲は
// group id をキーにした groupSpans に持つ（同じ id の文字は全員同じ範囲を指す）。
//
// 不変条件: 1 つの group の文字が 2 つ以上のセグメントに分かれることは絶対にない
// （崩れると閉じタグが割れて本文が二重出力される。例: `**https://u**https://u` で
// 裸URLステップが bold group の途中に部分的に触れるケース）。
// groupSpans[gid].content は、可視文字ごとの raw オフセット写像（segment.charMap）の元になる
// 情報 { srcStart, len }（raw 上での内容の開始位置と可視文字数）。1 マッチ 1 ピースの comp のみ、
// contentRange（またはコード復元ステップの 'inherit'）から埋める。複数マッチが合併した comp や
// ネストした装飾を含む内容は content を null のままにし、note-lines.js 側の丸めにフォールバックする
// これを守るため、1 回のステップ内の処理は 2 フェーズに分ける:
//   フェーズ A: そのステップの全マッチと、マッチが触れる既存 group ブロックを
//     安定するまで合併し、出力の区間分割を先に確定する
//   フェーズ B: 確定した区間分割を左から右へ 1 回だけ走査して出力する
// マッチ単位で出力しながら進めると、後続マッチの合併が出力済みの範囲に食い込むため、
// 分割の確定と出力の書き出しを分離している。合併区間には常に新しい group id を
// 割り当てる（既存 id の使い回しは、その group をさらに別の合併が巻き込むケースで
// 区間分割の再計算を招くため）

/**
 * comp の content（{ srcStart, len } | null）を求める。1 マッチ 1 ピースの comp だけが対象で、
 * 複数マッチが合併した comp は常に null（挙動不変の丸めへフォールバック）。
 * contentRange === 'inherit'（コード復元ステップ）は、comp がプレースホルダ全体＝直前ステップの
 * 単一 group とちょうど一致する前提で、その group の content をそのまま引き継ぐ。
 */
function computeContent(comp, contentRange, grp, srcIdx, groupSpans, matches) {
  if (comp.pieces.length !== 1 || !contentRange) return null;
  if (contentRange === 'inherit') {
    const g0 = grp[comp.start];
    if (g0 === -1 || grp[comp.end - 1] !== g0) return null;
    return groupSpans[g0] ? groupSpans[g0].content : null;
  }
  const r = contentRange(matches[comp.pieces[0]]);
  if (!r || r.end <= r.start) return null;
  for (let i = r.start; i < r.end; i++) {
    if (grp[i] !== -1) return null; // ネストした装飾は char 単位で追跡しない
  }
  return { srcStart: srcIdx[r.start], len: srcIdx[r.end - 1] - srcIdx[r.start] + 1 };
}

/**
 * comp が属するステップの種類（'code'|'bold'|'italic'|'del'|'image'|'link'|'bareurl'）を求める。
 * インライン生表示（reveal）が「どの装飾か」を判定するのに使う（content と違い常に comp 全体に対して
 * 定まる。合併した comp は最後に被せたステップ、すなわち一番外側の装飾を指す）。
 * kind === 'inherit'（コード復元ステップ）は、comp がプレースホルダ全体＝直前ステップの単一 group と
 * ちょうど一致する前提で、その group の kind をそのまま引き継ぐ。
 */
function computeKind(comp, kind, grp, groupSpans) {
  if (kind !== 'inherit') return kind;
  const g0 = grp[comp.start];
  if (g0 === -1 || grp[comp.end - 1] !== g0) return null;
  return groupSpans[g0] ? groupSpans[g0].kind : null;
}

function applyInlineStep(state, regex, buildHtml, contentRange, kind) {
  const { text, grp, srcIdx, groupSpans } = state;
  // ゼロ幅マッチは除去する。残すと [start, start) の空区間を持つ comp ができ、
  // フェーズ A/B の区間分割（区間は必ず非空という前提）が壊れる
  const matches = [...text.matchAll(regex)].filter((m) => m[0].length > 0);

  // 「不可分な最小単位」の境界を求める。装飾等で作られた group（grp !== -1）はもちろん、
  // plain（grp === -1）でも escapeAndTrackOffsets が生んだエンティティ展開
  // （例: raw の '>' 1 文字 → escaped の "&gt;" 4 文字、全員 srcIdx が同じ）は
  // 同じ raw 文字に由来する不可分な単位なので、マッチ境界がその途中に落ちても割ってはいけない
  // （割ると同じ raw 位置が 2 つのセグメントに属してしまう）
  function blockStart(pos) {
    const g = grp[pos];
    if (g === -1) {
      const sidx = srcIdx[pos];
      let s = pos;
      while (s > 0 && grp[s - 1] === -1 && srcIdx[s - 1] === sidx) s--;
      return s;
    }
    let s = pos;
    while (s > 0 && grp[s - 1] === g) s--;
    return s;
  }
  function blockEnd(lastPos) {
    const g = grp[lastPos];
    if (g === -1) {
      const sidx = srcIdx[lastPos];
      let e = lastPos + 1;
      while (e < grp.length && grp[e] === -1 && srcIdx[e] === sidx) e++;
      return e;
    }
    let e = lastPos + 1;
    while (e < grp.length && grp[e] === g) e++;
    return e;
  }

  // フェーズ A: 区間分割を確定する
  let comps = matches.map((m, idx) => ({ start: m.index, end: m.index + m[0].length, pieces: [idx] }));
  let changed = comps.length > 0;
  while (changed) {
    changed = false;
    for (const c of comps) {
      const bs = blockStart(c.start);
      if (bs < c.start) {
        c.start = bs;
        changed = true;
      }
      const be = blockEnd(c.end - 1);
      if (be > c.end) {
        c.end = be;
        changed = true;
      }
    }
    if (changed) {
      comps.sort((a, b) => a.start - b.start);
      const merged = [];
      for (const c of comps) {
        const last = merged[merged.length - 1];
        if (last && c.start < last.end) {
          last.end = Math.max(last.end, c.end);
          last.pieces.push(...c.pieces);
        } else {
          merged.push(c);
        }
      }
      comps = merged;
    }
  }

  // フェーズ B: 確定した区間分割を左から右へ 1 回だけ走査して出力する
  const newText = [];
  const newGrp = [];
  const newSrcIdx = [];
  function copyVerbatim(a, b, gid) {
    // a > b はフェーズ A の区間分割が壊れていない限り起こり得ない前提。
    // 黙って握りつぶすと閉じタグの消失のような不変条件違反を検出できなくなるため throw する
    if (a > b) throw new Error(`applyInlineStep: invalid range [${a}, ${b})`);
    if (a === b) return;
    newText.push(text.slice(a, b));
    for (let i = a; i < b; i++) {
      newGrp.push(gid === null ? grp[i] : gid);
      newSrcIdx.push(gid === null ? srcIdx[i] : -1);
    }
  }

  let cursor = 0;
  for (const comp of comps) {
    copyVerbatim(cursor, comp.start, null);

    let srcStart = Infinity;
    let srcEnd = -Infinity;
    for (let i = comp.start; i < comp.end; i++) {
      const g = grp[i];
      const span = g === -1 ? { srcStart: srcIdx[i], srcEnd: srcIdx[i] + 1 } : groupSpans[g];
      if (span.srcStart < srcStart) srcStart = span.srcStart;
      if (span.srcEnd > srcEnd) srcEnd = span.srcEnd;
    }
    const gid = state.nextGroupId++;
    groupSpans[gid] = {
      srcStart,
      srcEnd,
      content: computeContent(comp, contentRange, grp, srcIdx, groupSpans, matches),
      kind: computeKind(comp, kind, grp, groupSpans),
    };

    const pieces = comp.pieces.slice().sort((a, b) => matches[a].index - matches[b].index);
    let pos = comp.start;
    for (const idx of pieces) {
      const m = matches[idx];
      const pStart = m.index;
      const pEnd = pStart + m[0].length;
      copyVerbatim(pos, pStart, gid);
      const replacement = buildHtml(m);
      newText.push(replacement);
      for (let i = 0; i < replacement.length; i++) {
        newGrp.push(gid);
        newSrcIdx.push(-1);
      }
      pos = pEnd;
    }
    copyVerbatim(pos, comp.end, gid);

    cursor = comp.end;
  }
  copyVerbatim(cursor, text.length, null);

  state.text = newText.join('');
  state.grp = newGrp;
  state.srcIdx = newSrcIdx;
}

// escapeHtml と同じ変換（& → &amp; / < → &lt; / > → &gt;）を、raw 上のオフセットを
// 追跡しながら行う。エンティティに展開された文字は全員もとの raw 文字と同じ位置を指す
// （& 1文字 → &amp; の 5 文字全部が同じ raw index、という決定的な対応）
function escapeAndTrackOffsets(raw) {
  let text = '';
  const srcIdx = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const piece = c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c;
    text += piece;
    for (let k = 0; k < piece.length; k++) srcIdx.push(i);
  }
  return { text, srcIdx };
}

// escapeAndTrackOffsets の逆変換。visibleText（DOM textContent 相当）を組み立てるためだけに使う。
// &amp; を最後にデコードすること: 先にデコードすると、たとえば &amp;lt; のような
// （このモジュールが生成することはないが）文字列を "&lt;" → さらに "<" と二重にデコードしてしまう
function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// html.replace(/<[^>]*>/g, '') は属性値の中身を見ないため、属性値に生の '>' を含む HTML
// （例: href 属性の中に code 復元で <code> タグが混入するケース）で誤ってタグの終わりと
// 誤認し、属性値の一部が可視テキストとして漏れ出す。タグの外側にいるか、タグの中でも
// 引用符（" / '）に入っているかを状態機械で追跡し、引用符内の '>' は無視して正しくタグだけを除去する
function stripTagsQuoteAware(html) {
  let out = '';
  let i = 0;
  const n = html.length;
  while (i < n) {
    const c = html[i];
    if (c !== '<') {
      out += c;
      i++;
      continue;
    }
    // タグの内部（i はタグ開始の '<' の直後から始める）
    i++;
    let quote = null;
    while (i < n) {
      const ch = html[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        i++;
        break;
      }
      i++;
    }
  }
  return out;
}

// インライン生表示（reveal）で「マーカーごと生 raw を見せてよい」装飾の種類。画像は raw が
// alt/src の属性にしか現れず見せても意味がなく、裸URLはそもそも raw === 可視テキストで
// 隠れているマーカーが無いため対象外にする。
const REVEALABLE_KINDS = new Set(['code', 'bold', 'italic', 'del', 'link']);
function isRevealableKind(kind) {
  return REVEALABLE_KINDS.has(kind);
}

/**
 * raw（escapeHtml 前）の行テキストからインライン装飾を解決し、セグメント列を返す。
 * 各セグメントは { srcStart, srcEnd, html, visibleText, charMap, kind }。
 *   - srcStart/srcEnd は raw 文字列上のオフセット（[srcStart, srcEnd) の半開区間）。
 *     全セグメントの srcStart/srcEnd は [0, raw.length) を隙間なく覆う
 *   - html は全セグメント連結すると inlineMarkdown(escapeHtml(raw)) と完全一致する
 *   - visibleText は DOM の textContent 相当（タグを除去しエンティティをデコードした可視文字）
 *   - charMap は { srcStart, len } | null。非 null なら可視文字 i（0 <= i < len）が
 *     raw オフセット charMap.srcStart + i に厳密対応する（対称マーカーの装飾・リンクラベル・
 *     裸URLで、ネストした装飾を含まない場合のみ）。null は画像・ネスト装飾など、
 *     可視文字と raw 位置が 1:1 対応しない（呼び出し側は srcStart/srcEnd への丸めに頼る）
 *   - kind は 'code'|'bold'|'italic'|'del'|'image'|'link'|'bareurl'|null（プレーンテキスト）。
 *     isRevealableKind(kind) が true のセグメントだけが reveal 対象になりうる
 * srcStart/srcEnd は「トップレベルの構成要素」単位（ネストした装飾は外側 1 セグメントの html に含まれる）。
 *
 * @param {string} raw
 * @param {{start: number, end: number} | null} [reveal] 指定すると、raw 上で
 *   [reveal.start, reveal.end) にちょうど一致する reveal 対象セグメント（isRevealableKind）を、
 *   装飾変換を通さない生テキストの html（charMap は raw への恒等写像）に差し替える。一致する
 *   セグメントが無ければ何もしない（インライン生表示の描画・写像が reveal 状態を考慮するのに使う）
 */
function inlineSegments(raw, reveal) {
  const { text: initialText, srcIdx: initialSrcIdx } = escapeAndTrackOffsets(raw);
  const state = {
    text: initialText,
    grp: new Array(initialText.length).fill(-1),
    srcIdx: initialSrcIdx,
    groupSpans: {},
    nextGroupId: 0,
  };

  const codeBlocks = [];
  applyInlineStep(state, CODE_RE, (m) => {
    codeBlocks.push(m[1]);
    return '\x00CODE' + (codeBlocks.length - 1) + '\x00';
  }, codeContentRange, 'code');
  applyInlineStep(state, BOLD_RE, (m) => buildStrongHtml(m[1]), boldContentRange, 'bold');
  applyInlineStep(state, ITALIC_RE, (m) => buildEmHtml(m[1]), italicContentRange, 'italic');
  applyInlineStep(state, DEL_RE, (m) => buildDelHtml(m[1]), delContentRange, 'del');
  applyInlineStep(state, IMAGE_RE, (m) => buildImageHtml(m[1], m[2]), null, 'image');
  applyInlineStep(state, LINK_RE, (m) => buildLinkHtml(m[1], m[2]), linkContentRange, 'link');
  applyInlineStep(state, BAREURL_RE, (m) => buildBareUrlHtml(m[1], m[2]), bareUrlContentRange, 'bareurl');
  applyInlineStep(state, CODE_RESTORE_RE, (m) => '<code>' + codeBlocks[m[1]] + '</code>', 'inherit', 'inherit');

  const segments = [];
  let i = 0;
  while (i < state.text.length) {
    const g = state.grp[i];
    let j = i + 1;
    while (j < state.text.length && state.grp[j] === g) j++;
    const html = state.text.slice(i, j);
    const { srcStart, srcEnd, content, kind } =
      g === -1
        ? { srcStart: state.srcIdx[i], srcEnd: state.srcIdx[j - 1] + 1, content: null, kind: null }
        : state.groupSpans[g];
    const visibleText = decodeEntities(stripTagsQuoteAware(html));
    // content.len は可視文字数のはずだが、想定外の不一致があれば安全側（丸めへのフォールバック）に倒す
    const charMap = content && content.len === visibleText.length ? content : null;
    if (reveal && srcStart === reveal.start && srcEnd === reveal.end && isRevealableKind(kind)) {
      const literalRaw = raw.slice(srcStart, srcEnd);
      segments.push({
        srcStart,
        srcEnd,
        html: `<span class="md-reveal">${escapeHtml(literalRaw)}</span>`,
        visibleText: literalRaw,
        charMap: { srcStart, len: literalRaw.length },
        kind,
      });
    } else {
      segments.push({ srcStart, srcEnd, html, visibleText, charMap, kind });
    }
    i = j;
  }
  return segments;
}

/**
 * 行配列を先頭から走査し、コードブロックとして描画するフェンスの範囲を
 * Map<開始行, { end, closed }> で返す（開始行は開きフェンス自身）。renderMarkdown（フェンスの
 * 描画判定）と note.js の末尾空行正規化（閉じフェンスが最終行になったら空行を1行足す）が
 * 同じ判定を共有するための土台。
 *
 * end は閉じフェンス自身の行（内容は [開始行+1, end) ）。closed は常に true（範囲に含める
 * フェンスは開き・閉じが揃っているものだけのため）。
 *
 * 対応する閉じフェンスの無い開きフェンスはコードブロック化せず、常にリテラルのテキスト行として
 * 扱う（範囲に含めない）。
 */
function scanFenceRanges(lines) {
  const ranges = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!/^```\s*$/.test(lines[i])) continue;
    let closeIdx = -1;
    for (let k = i + 1; k < lines.length; k++) {
      if (/^```\s*$/.test(lines[k])) { closeIdx = k; break; }
    }
    if (closeIdx !== -1) {
      ranges.set(i, { end: closeIdx, closed: true });
      i = closeIdx;
    }
    // else: 閉じフェンスが無い → リテラル行として扱う（範囲に含めず素通り）
  }
  return ranges;
}

/** 行（fence 範囲は含まない、1 行単位）のブロック種別を判定する。renderMarkdown 本体と、
 * note.js の変換検出（splice 前後でこの種別が変わったかを比較し、undo チェックポイントの
 * トリガーにする）が同じ判定を共有するための土台。fence はここに含めず scanFenceRanges 側の
 * 責務のまま（複数行にまたがる判定のため 1 行単位のこの関数とは性質が異なる）。
 *
 * contentStart は trimmedLine 上でのマーカー長（renderInline に渡す内容の開始位置）。
 * trimmedLine.slice(contentStart) が renderInline に渡る内容と一致し、renderMarkdown・
 * lineConversionOccurred の双方がここから同じ値を引く（slice 幅の二重管理を避ける）。 */
function classifyLine(line) {
  // インデントは 2 スペース単位。奇数分は切り捨てる（例: 半端な 3 スペースは level 1 のまま）。
  // タブ文字は非対応（スペースのみ見る）
  const indentMatch = line.match(/^( +)/);
  const spaces = indentMatch ? indentMatch[1].length : 0;
  const level = Math.floor(spaces / 2);
  const trimmedLine = spaces > 0 ? line.slice(spaces) : line;
  let type, contentStart;
  if (/^[-*] \[x\] /i.test(trimmedLine)) { type = 'checked'; contentStart = 6; }
  else if (/^[-*] \[ \] /.test(trimmedLine)) { type = 'checkbox'; contentStart = 6; }
  else if (level === 0 && trimmedLine.startsWith('### ')) { type = 'h3'; contentStart = 4; }
  else if (level === 0 && trimmedLine.startsWith('## ')) { type = 'h2'; contentStart = 3; }
  else if (level === 0 && trimmedLine.startsWith('# ')) { type = 'h1'; contentStart = 2; }
  else if (level === 0 && /^([-*_])\s*(?:\1\s*){2,}$/.test(trimmedLine)) { type = 'hr'; contentStart = trimmedLine.length; }
  else if (/^[-*] /.test(trimmedLine)) { type = 'bullet'; contentStart = 2; }
  else if (/^> /.test(trimmedLine)) { type = 'quote'; contentStart = 2; }
  else if (/^\d+\. /.test(trimmedLine)) { type = 'ordered'; contentStart = trimmedLine.match(/^\d+\. /)[0].length; }
  else if (line === '') { type = 'empty'; contentStart = 0; }
  else { type = 'text'; contentStart = 0; }
  return { type, trimmedLine, level, contentStart };
}

/** line 単体のブロック種別・インライン装飾が before → after で新規に成立したか。classifyLine・
 * inlineSegments という描画側の判定をそのまま比較に使い、変換の意味を独自パーサで再定義しない。
 * ブロック種別の変化は、行き先が装飾の付かない 'text'/'empty' のとき対象外にする（装飾解除の
 * 逆方向・空行への最初の 1 文字目は「変換」ではない）。インライン装飾は kind ごとの出現数を
 * 比較し、増えた kind があれば新規成立とみなす（前段の中間状態が別 kind に見える場合があっても、
 * 完成した kind の増加自体は検出できる）。inlineKindCounts へは classifyLine の contentStart で
 * マーカーを除いた内容だけを渡す（マーカー込みで渡すと、行頭の `* ` のようなマーカーの一部を
 * ITALIC_RE 等が装飾の一部として誤って食い込む）。フェンス内容行の除外は呼び出し側の責務
 * （note.js の checkpointConversion）で、この関数自身は行の所属を知らない。 */
function lineConversionOccurred(before, after) {
  if (before === after) return false;
  const beforeInfo = classifyLine(before);
  const afterInfo = classifyLine(after);
  if (afterInfo.type !== beforeInfo.type && afterInfo.type !== 'text' && afterInfo.type !== 'empty') return true;
  const beforeCounts = inlineKindCounts(beforeInfo.trimmedLine.slice(beforeInfo.contentStart));
  for (const [kind, count] of inlineKindCounts(afterInfo.trimmedLine.slice(afterInfo.contentStart))) {
    if (count > (beforeCounts.get(kind) || 0)) return true;
  }
  return false;
}

/** content（マーカーを除いた内容）の inlineSegments を kind ごとの出現数へ集計する
 * （プレーンテキスト側の kind: null は含まない）。 */
function inlineKindCounts(content) {
  const counts = new Map();
  for (const seg of inlineSegments(content)) {
    if (seg.kind) counts.set(seg.kind, (counts.get(seg.kind) || 0) + 1);
  }
  return counts;
}

/** 行内容（マーカーを除いた raw）を装飾込みの html にする。revealRange（{start, end}、
 * text 上のローカルな raw オフセット）を渡すと、それに一致する装飾セグメントだけ生 raw で
 * 表示する（inlineSegments 経由）。無指定時は通常の逐次置換チェーン（inlineMarkdown）を使う。 */
function renderInline(text, revealRange) {
  if (!revealRange) return inlineMarkdown(escapeHtml(text));
  return inlineSegments(text, revealRange).map((s) => s.html).join('');
}

/**
 * @param {string} text
 * @param {{line: number, start: number, end: number} | null} [reveal] インライン生表示の
 *   対象行・範囲（start/end はその行のマーカーを除いた内容上の raw オフセット）。指定した行の
 *   一致する装飾セグメントだけ生 raw で表示する（renderInline 参照）。
 */
function renderMarkdown(text, reveal) {
  if (!text) {
    // window.I18N を読み込まずに renderMarkdown 単体を呼ぶ場面（テスト・node 環境等）でも壊れないようフォールバックする
    const placeholder = (typeof window !== 'undefined' && window.I18N) ? window.I18N.t('notePlaceholder') : 'メモを入力…';
    // data-line 付きの空ブロックにし、プレースホルダ文言は ::before の CSS content（data-placeholder
    // 属性）で表示だけする。文言をテキストノードとして直接持たせると、それ自体がキャレットの
    // 着地点・編集対象になってしまい、空の付箋へキャレットを置けなくなる
    return `<div class="md-empty md-placeholder" data-line="0" data-placeholder="${escapeAttr(placeholder)}"></div>`;
  }
  // Normalize non-breaking spaces (contenteditable often inserts \u00A0)
  const lines = text.replace(/\u00A0/g, ' ').split('\n');
  const result = [];
  const fenceRanges = scanFenceRanges(lines);
  const orderedCounters = {}; // track counters per indent level
  let lastOrderedLevel = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceRanges.has(i)) {
      const { end, closed } = fenceRanges.get(i);
      const codeLines = lines.slice(i + 1, closed ? end : end + 1);
      // 末尾の内容行が空のとき、<pre> のテキストは "\n" で終わるが末尾の改行は行ボックスを
      // 作らないため、その空行が描画されずキャレットも置けない。<br> フィラーで行ボックスを
      // 確保する（テキストノードの後ろに足すのでソース位置とのオフセット対応は変わらない）
      const filler = codeLines.length && codeLines[codeLines.length - 1] === '' ? '<br>' : '';
      result.push(`<pre class="md-codeblock" data-line="${i}" data-line-end="${end}"><code>` + codeLines.map(l => escapeHtml(l)).join('\n') + filler + '</code></pre>');
      i = end;
      continue;
    }
    const { type, trimmedLine, level, contentStart } = classifyLine(line);
    const content = trimmedLine.slice(contentStart);
    const indentClass = level > 0 ? ` md-indent-${Math.min(level, 5)}` : '';
    const revealHere = reveal && reveal.line === i ? { start: reveal.start, end: reveal.end } : null;

    // Reset ordered list counters when line is not a numbered list
    if (type !== 'ordered') {
      lastOrderedLevel = -1;
      Object.keys(orderedCounters).forEach(k => delete orderedCounters[k]);
    }

    // 内容が空だと <span></span> にテキストノードが 1 つも無くなり、raw 位置から DOM 位置への
    // 解決（note.js の domPointForContentVisible）がテキストノードを見つけられず、ブロック
    // 直下（<input> の直前 = 見た目上チェックボックスの位置）へフォールバックしてしまう。
    // 潰れない文字（&nbsp;）を 1 つ挟んでテキストノードを確保する
    if (type === 'checked') {
      const inner = renderInline(content, revealHere) || '&nbsp;';
      result.push(`<div class="md-check checked${indentClass}" data-line="${i}"><input type="checkbox" checked data-line="${i}"><span>${inner}</span></div>`);
      continue;
    }
    if (type === 'checkbox') {
      const inner = renderInline(content, revealHere) || '&nbsp;';
      result.push(`<div class="md-check${indentClass}" data-line="${i}"><input type="checkbox" data-line="${i}"><span>${inner}</span></div>`);
      continue;
    }
    if (type === 'h3') {
      result.push(`<div class="md-h3" data-line="${i}">${renderInline(content, revealHere)}</div>`);
      continue;
    }
    if (type === 'h2') {
      result.push(`<div class="md-h2" data-line="${i}">${renderInline(content, revealHere)}</div>`);
      continue;
    }
    if (type === 'h1') {
      result.push(`<div class="md-h1" data-line="${i}">${renderInline(content, revealHere)}</div>`);
      continue;
    }
    if (type === 'hr') {
      result.push(`<hr class="md-hr" data-line="${i}">`);
      continue;
    }
    if (type === 'bullet') {
      result.push(`<div class="md-bullet${indentClass}" data-line="${i}">${renderInline(content, revealHere)}</div>`);
      continue;
    }
    if (type === 'quote') {
      result.push(`<div class="md-blockquote${indentClass}" data-line="${i}">${renderInline(content, revealHere)}</div>`);
      continue;
    }
    if (type === 'ordered') {
      // Auto-increment: reset counter only for new deeper nesting or new list block
      if (lastOrderedLevel < 0) {
        // New ordered list block after non-list line
        orderedCounters[level] = 1;
      } else if (level > lastOrderedLevel) {
        // Going deeper — start new sub-list
        orderedCounters[level] = 1;
      } else {
        // Same level or returning from deeper — continue counting
        orderedCounters[level] = (orderedCounters[level] || 0) + 1;
      }
      lastOrderedLevel = level;
      const displayNum = orderedCounters[level];
      // 内容が空だと通常の半角スペースは contenteditable 上で潰れてしまい（他に文字が無い
      // ノードの末尾空白は折りたたまれる）、キャレットの着地点が無くなって beforeinput が
      // 発火しない。潰れない区切り文字として &nbsp;（U+00A0）を使う
      const sep = content === '' ? ' ' : ' ';
      result.push(`<div class="md-ordered${indentClass}" data-line="${i}"><span class="md-order-num">${displayNum}.</span>${sep}${renderInline(content, revealHere)}</div>`);
      continue;
    }
    if (type === 'empty') {
      result.push(`<div class="md-empty" data-line="${i}"></div>`);
      continue;
    }
    result.push(`<div class="md-line${indentClass}" data-line="${i}">${renderInline(content, revealHere)}</div>`);
  }
  return result.join('');
}

// ブラウザでは module が未定義なので、この行は classic script の読み込みに影響しない
if (typeof module !== 'undefined') {
  module.exports = {
    renderMarkdown, inlineMarkdown, inlineSegments, parseImageAlt, scanFenceRanges, isRevealableKind,
    classifyLine, lineConversionOccurred, inlineKindCounts,
  };
}
