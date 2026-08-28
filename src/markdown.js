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
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
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
// これを守るため、1 回のステップ内の処理は 2 フェーズに分ける:
//   フェーズ A: そのステップの全マッチと、マッチが触れる既存 group ブロックを
//     安定するまで合併し、出力の区間分割を先に確定する
//   フェーズ B: 確定した区間分割を左から右へ 1 回だけ走査して出力する
// マッチ単位で出力しながら進めると、後続マッチの合併が出力済みの範囲に食い込むため、
// 分割の確定と出力の書き出しを分離している。合併区間には常に新しい group id を
// 割り当てる（既存 id の使い回しは、その group をさらに別の合併が巻き込むケースで
// 区間分割の再計算を招くため）

function applyInlineStep(state, regex, buildHtml) {
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
    groupSpans[gid] = { srcStart, srcEnd };

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

/**
 * raw（escapeHtml 前）の行テキストからインライン装飾を解決し、セグメント列を返す。
 * 各セグメントは { srcStart, srcEnd, html, visibleText }。
 *   - srcStart/srcEnd は raw 文字列上のオフセット（[srcStart, srcEnd) の半開区間）。
 *     全セグメントの srcStart/srcEnd は [0, raw.length) を隙間なく覆う
 *   - html は全セグメント連結すると inlineMarkdown(escapeHtml(raw)) と完全一致する
 *   - visibleText は DOM の textContent 相当（タグを除去しエンティティをデコードした可視文字）
 * srcStart/srcEnd は「トップレベルの構成要素」単位（ネストした装飾は外側 1 セグメントの html に含まれる）。
 */
function inlineSegments(raw) {
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
  });
  applyInlineStep(state, BOLD_RE, (m) => buildStrongHtml(m[1]));
  applyInlineStep(state, ITALIC_RE, (m) => buildEmHtml(m[1]));
  applyInlineStep(state, DEL_RE, (m) => buildDelHtml(m[1]));
  applyInlineStep(state, IMAGE_RE, (m) => buildImageHtml(m[1], m[2]));
  applyInlineStep(state, LINK_RE, (m) => buildLinkHtml(m[1], m[2]));
  applyInlineStep(state, BAREURL_RE, (m) => buildBareUrlHtml(m[1], m[2]));
  applyInlineStep(state, CODE_RESTORE_RE, (m) => '<code>' + codeBlocks[m[1]] + '</code>');

  const segments = [];
  let i = 0;
  while (i < state.text.length) {
    const g = state.grp[i];
    let j = i + 1;
    while (j < state.text.length && state.grp[j] === g) j++;
    const html = state.text.slice(i, j);
    const { srcStart, srcEnd } =
      g === -1 ? { srcStart: state.srcIdx[i], srcEnd: state.srcIdx[j - 1] + 1 } : state.groupSpans[g];
    segments.push({ srcStart, srcEnd, html, visibleText: decodeEntities(stripTagsQuoteAware(html)) });
    i = j;
  }
  return segments;
}

function renderMarkdown(text) {
  if (!text) {
    // window.I18N を読み込まずに renderMarkdown 単体を呼ぶ場面（テスト・node 環境等）でも壊れないようフォールバックする
    const placeholder = (typeof window !== 'undefined' && window.I18N) ? window.I18N.t('notePlaceholder') : 'メモを入力…';
    return `<div class="md-placeholder">${placeholder}</div>`;
  }
  // Normalize non-breaking spaces (contenteditable often inserts \u00A0)
  const lines = text.replace(/\u00A0/g, ' ').split('\n');
  const result = [];
  let inCodeBlock = false;
  let codeLines = [];
  let codeStart = 0;
  const orderedCounters = {}; // track counters per indent level
  let lastOrderedLevel = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inCodeBlock && /^```\S*\s*$/.test(line)) {
      inCodeBlock = true;
      codeLines = [];
      codeStart = i;
      continue;
    }
    if (inCodeBlock && /^```\s*$/.test(line)) {
      result.push(`<pre class="md-codeblock" data-line="${codeStart}" data-line-end="${i}"><code>` + codeLines.map(l => escapeHtml(l)).join('\n') + '</code></pre>');
      inCodeBlock = false;
      codeLines = [];
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }
    // Measure and strip indent for nested lists
    // Indent level is based on 2-space units; odd spaces are truncated (e.g. 3 spaces = level 1)
    // Note: only spaces are considered; tab characters are not supported and will be ignored
    const indentMatch = line.match(/^( +)/);
    const spaces = indentMatch ? indentMatch[1].length : 0;
    const level = Math.floor(spaces / 2);
    const trimmedLine = spaces > 0 ? line.slice(spaces) : line;
    const indentClass = level > 0 ? ` md-indent-${Math.min(level, 5)}` : '';

    // Reset ordered list counters when line is not a numbered list
    if (!/^\d+\. /.test(trimmedLine)) {
      lastOrderedLevel = -1;
      Object.keys(orderedCounters).forEach(k => delete orderedCounters[k]);
    }

    if (/^[-*] \[x\] /i.test(trimmedLine)) {
      result.push(`<div class="md-check checked${indentClass}" data-line="${i}"><input type="checkbox" checked data-line="${i}"><span>${inlineMarkdown(escapeHtml(trimmedLine.slice(6)))}</span></div>`);
      continue;
    }
    if (/^[-*] \[ \] /.test(trimmedLine)) {
      result.push(`<div class="md-check${indentClass}" data-line="${i}"><input type="checkbox" data-line="${i}"><span>${inlineMarkdown(escapeHtml(trimmedLine.slice(6)))}</span></div>`);
      continue;
    }
    if (level === 0 && trimmedLine.startsWith('### ')) {
      result.push(`<div class="md-h3" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine.slice(4)))}</div>`);
      continue;
    }
    if (level === 0 && trimmedLine.startsWith('## ')) {
      result.push(`<div class="md-h2" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine.slice(3)))}</div>`);
      continue;
    }
    if (level === 0 && trimmedLine.startsWith('# ')) {
      result.push(`<div class="md-h1" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine.slice(2)))}</div>`);
      continue;
    }
    if (level === 0 && /^([-*_])\s*(?:\1\s*){2,}$/.test(trimmedLine)) {
      result.push(`<hr class="md-hr" data-line="${i}">`);
      continue;
    }
    if (/^[-*] /.test(trimmedLine)) {
      result.push(`<div class="md-bullet${indentClass}" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine.slice(2)))}</div>`);
      continue;
    }
    if (/^> /.test(trimmedLine)) {
      result.push(`<div class="md-blockquote${indentClass}" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine.slice(2)))}</div>`);
      continue;
    }
    if (/^\d+\. /.test(trimmedLine)) {
      const m = trimmedLine.match(/^(\d+)\. (.*)/);
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
      result.push(`<div class="md-ordered${indentClass}" data-line="${i}"><span class="md-order-num">${displayNum}.</span> ${inlineMarkdown(escapeHtml(m[2]))}</div>`);
      continue;
    }
    if (line === '') {
      result.push(`<div class="md-empty" data-line="${i}"></div>`);
      continue;
    }
    result.push(`<div class="md-line${indentClass}" data-line="${i}">${inlineMarkdown(escapeHtml(trimmedLine))}</div>`);
  }
  // Handle unclosed code block
  if (inCodeBlock) {
    result.push(`<pre class="md-codeblock" data-line="${codeStart}" data-line-end="${lines.length - 1}"><code>` + codeLines.map(l => escapeHtml(l)).join('\n') + '</code></pre>');
  }
  return result.join('');
}

// ブラウザでは module が未定義なので、この行は classic script の読み込みに影響しない
if (typeof module !== 'undefined') {
  module.exports = { renderMarkdown, inlineMarkdown, inlineSegments };
}
