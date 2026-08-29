const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { escapeHtml } = require("../../src/utils.js");
global.escapeHtml = escapeHtml;
const { inlineMarkdown, inlineSegments } = require("../../src/markdown.js");

// inlineMarkdown はインライン記法(bold/italic/del/code/image/link/裸URL)の変換本体。
// ここでは escapeHtml 済みの文字列を直接渡し、素の逐次置換チェーンの出力をゴールデンマスターとして固定する。
// inlineSegments は raw（escapeHtml 前）テキストを受け取る独立経路で、同じ置換チェーンを
// オフセット追跡しながら適用する。html はどちらの経路でも 1 バイトも変わらない前提。
//
// 現実装の癖（そのまま固定している）:
// - ネスト（*a **b** c*）: bold が先に置換されるため、em が strong を包む
// - リンクテキストが URL のケース（[https://a.example](https://b.example)）:
//   link 変換後に残る内側の URL テキストがバレ URL 変換の対象になり、<a> の中に <a> がネストする
// - *** / **** の境界ケース: bold の非貪欲マッチと italic の再マッチが交差し、
//   開始・終了タグの対応が入れ子として揃わない（<strong><em>text</strong></em> 等）
// - 装飾直後に裸URLが続くケース（**https://u**https://u 等）: 裸URL変換のマッチが
//   直前の装飾 group の途中に触れるため、inlineSegments 側は装飾と裸URLをまとめて
//   1 セグメントに合併する（group が 2 つのセグメントに分裂しないための不変条件）
const corpus = [
  { name: "plain text", raw: "hello world", html: "hello world" },
  { name: "empty string", raw: "", html: "" },
  { name: "bold only", raw: "**bold**", html: "<strong>bold</strong>" },
  { name: "italic only", raw: "*italic*", html: "<em>italic</em>" },
  { name: "strikethrough only", raw: "~~del~~", html: "<del>del</del>" },
  { name: "code only", raw: "`code`", html: "<code>code</code>" },
  {
    name: "bold and italic combined",
    raw: "**bold** and *italic*",
    html: "<strong>bold</strong> and <em>italic</em>",
  },
  {
    name: "italic wraps bold (nested)",
    raw: "*a **b** c*",
    html: "<em>a <strong>b</strong> c</em>",
  },
  {
    name: "code protects bold marker inside",
    raw: "`**not bold**`",
    html: "<code>**not bold**</code>",
  },
  {
    name: "code protects italic marker inside",
    raw: "`*a*`",
    html: "<code>*a*</code>",
  },
  {
    name: "bold containing code",
    raw: "**bold `code` here**",
    html: "<strong>bold <code>code</code> here</strong>",
  },
  { name: "unclosed bold", raw: "**a", html: "**a" },
  { name: "unclosed italic", raw: "*a", html: "*a" },
  { name: "unclosed code", raw: "`a", html: "`a" },
  {
    name: "image basic",
    raw: "![alt](images/a.png)",
    html: '<img alt="alt" src="images/a.png" data-rel-src="images/a.png" title="ダブルクリックで開く">',
  },
  {
    name: "image with width",
    raw: "![alt|300](images/a.png)",
    html: '<img alt="alt" src="images/a.png" data-rel-src="images/a.png" title="ダブルクリックで開く" width="300">',
  },
  {
    name: "image empty alt",
    raw: "![](images/a.png)",
    html: '<img alt="" src="images/a.png" data-rel-src="images/a.png" title="ダブルクリックで開く">',
  },
  {
    name: "link",
    raw: "[text](https://example.com)",
    html: '<a href="https://example.com" data-url="https://example.com">text</a>',
  },
  {
    name: "bare url",
    raw: "visit https://example.com today",
    html: 'visit <a href="https://example.com" data-url="https://example.com">https://example.com</a> today',
  },
  {
    name: "link text is a different url",
    raw: "[https://a.example](https://b.example)",
    html:
      '<a href="https://b.example" data-url="https://b.example">' +
      '<a href="https://a.example" data-url="https://a.example">https://a.example</a></a>',
  },
  {
    name: "url right after a quote (skip case)",
    raw: '"https://example.com',
    html: '"https://example.com',
  },
  {
    name: "url right after equals (skip case)",
    raw: "=https://example.com",
    html: "=https://example.com",
  },
  { name: "escaped ampersand input", raw: "a & b", html: "a &amp; b" },
  { name: "escaped lt input", raw: "a < b", html: "a &lt; b" },
  {
    name: "triple asterisks",
    raw: "***text***",
    html: "<strong><em>text</strong></em>",
  },
  {
    name: "quadruple asterisks",
    raw: "****text****",
    html: "<strong>*<em>text</strong></em>*",
  },
  {
    name: "image nested inside link",
    raw: "[![alt](images/a.png)](https://example.com)",
    html:
      '<a href="https://example.com" data-url="https://example.com">' +
      '<img alt="alt" src="images/a.png" data-rel-src="images/a.png" title="ダブルクリックで開く"></a>',
  },
  // 装飾直後に隙間なく裸URLが続くケース: 裸URL変換のマッチが直前の装飾 group の
  // 途中に触れるため、group が分裂しないことの検証になる
  {
    name: "bold immediately followed by a bare url (reported bug repro)",
    raw: "**https://u**https://u",
    html:
      '<strong><a href="https://u" data-url="https://u">https://u</a></strong>' +
      '<a href="https://u" data-url="https://u">https://u</a>',
  },
  {
    name: "italic immediately followed by a bare url (reported bug repro)",
    raw: "*ahttps://u*https://u",
    html:
      '<em>a<a href="https://u" data-url="https://u">https://u</a></em>' +
      '<a href="https://u" data-url="https://u">https://u</a>',
  },
  {
    name: "strikethrough immediately followed by a bare url (reported bug repro)",
    raw: "~~https://u~~https://u",
    html:
      '<del><a href="https://u" data-url="https://u">https://u</a></del>' +
      '<a href="https://u" data-url="https://u">https://u</a>',
  },
  {
    name: "triple-asterisk bold immediately followed by a bare url (reported bug repro)",
    raw: "***https://u**https://u",
    html:
      '<strong>*<a href="https://u" data-url="https://u">https://u</a></strong>' +
      '<a href="https://u" data-url="https://u">https://u</a>',
  },
  // 裸URLの直後に隙間なくコードスパンが続くケース: code 復元ステップが href/data-url
  // 属性値の中にまで <code> タグを混入させる（置換チェーンの癖）。タグ除去が引用符を
  // 意識しないと属性値内の '>' で誤って切れ、visibleText に属性値の断片が漏れ出す
  {
    name: "bare url immediately followed by a code span (visibleText bug repro)",
    raw: "https://u`x`",
    html: '<a href="https://u<code>x</code>" data-url="https://u<code>x</code>">https://u<code>x</code></a>',
  },
  {
    name: "link whose url is immediately followed by a code span (visibleText bug repro)",
    raw: "[t](https://u`x`)",
    html: '<a href="https://u<code>x</code>" data-url="https://u<code>x</code>">t</a>',
  },
];

describe("inlineMarkdown — ゴールデンマスター", () => {
  for (const { name, raw, html } of corpus) {
    test(name, () => {
      assert.equal(inlineMarkdown(escapeHtml(raw)), html);
    });
  }
});

// visibleText（DOM textContent 相当）を、実装（src/markdown.js の stripTagsQuoteAware +
// decodeEntities）とは別の書き方で独立に計算する。トートロジー再発防止のため、実装と
// 同じ「文字を1つずつ舐めるループ」ではなく indexOf でタグの開始位置へジャンプする方式にし、
// エンティティのデコードも replace ではなく split/join にして式そのものを変えている
function independentTextContent(html) {
  let out = "";
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) {
      out += html.slice(pos);
      break;
    }
    out += html.slice(pos, lt);
    let cursor = lt + 1;
    let quote = null;
    while (cursor < html.length) {
      const ch = html[cursor];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        cursor++;
        break;
      }
      cursor++;
    }
    pos = cursor;
  }
  return out.split("&lt;").join("<").split("&gt;").join(">").split("&amp;").join("&");
}

describe("inlineSegments — 不変条件", () => {
  for (const { name, raw } of corpus) {
    test(name, () => {
      const segments = inlineSegments(raw);

      // 被覆: [0, raw.length) を隙間なく覆う
      let cursor = 0;
      for (const seg of segments) {
        assert.equal(seg.srcStart, cursor, `srcStart は直前の srcEnd と連続する: ${name}`);
        assert.ok(seg.srcEnd > seg.srcStart, `srcEnd は srcStart より大きい: ${name}`);
        cursor = seg.srcEnd;
      }
      assert.equal(cursor, raw.length, `全セグメントの合計が raw 全体を覆う: ${name}`);

      // 装飾セグメントを含め、全セグメントの raw.slice(srcStart, srcEnd) を順に連結すると raw 全体に一致する
      const joinedSrc = segments.map((s) => raw.slice(s.srcStart, s.srcEnd)).join("");
      assert.equal(joinedSrc, raw, `セグメントの src 範囲を連結すると raw に一致する: ${name}`);

      // html 一致: 連結すると inlineMarkdown(escapeHtml(raw)) の出力と完全一致する
      const joinedHtml = segments.map((s) => s.html).join("");
      assert.equal(
        joinedHtml,
        inlineMarkdown(escapeHtml(raw)),
        `html 連結が inlineMarkdown(escapeHtml(raw)) と一致する: ${name}`
      );

      // プレーンセグメント（装飾を含まない）では visibleText === raw.slice(srcStart, srcEnd)
      for (const seg of segments) {
        if (!/[<>]/.test(seg.html)) {
          assert.equal(
            seg.visibleText,
            raw.slice(seg.srcStart, seg.srcEnd),
            `プレーンセグメントの visibleText は raw の対応部分と一致する: ${name}`
          );
        }
      }

      // 全セグメントで visibleText が、独立実装（タグ除去 + エンティティデコード）の結果と一致する
      for (const seg of segments) {
        assert.equal(
          seg.visibleText,
          independentTextContent(seg.html),
          `visibleText は独立実装のタグ除去(引用符対応)+デコード結果と一致する: ${name}`
        );
      }
    });
  }

  test("空文字列はセグメント 0 件", () => {
    assert.deepEqual(inlineSegments(""), []);
  });
});

// ── inlineMarkdown / inlineSegments 二経路の出力一致 (property test) ──────────────
// inlineMarkdown（素の逐次置換チェーン）と inlineSegments（オフセット追跡付きの別経路）は
// 同じ置換チェーンを共有しているはずだが、経路が分かれている以上、固定コーパスだけでは
// 突き合わせきれない組み合わせが残る。シード固定の擬似乱数（xorshift32）で
// Markdown 記法に使う記号（改行・日本語・サロゲートペア・バッククォートと URL の隣接形を含む）
// を交えたランダム入力を大量生成し、以下を検証する。Math.random / Date.now は使わない
// （実行のたびに再現性が変わってしまうため）:
//   (a) セグメント被覆の連続性（[0, raw.length) を隙間なく覆う）
//   (b) 全セグメントの raw.slice(srcStart, srcEnd) を連結すると raw に一致する
//   (c) html 連結が inlineMarkdown(escapeHtml(raw)) と一致する
//   (d) visibleText が独立実装（タグ除去（引用符対応）+ エンティティデコード）の結果と一致する
describe("inlineMarkdown / inlineSegments — 二経路の出力一致 (fuzz)", () => {
  function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return function next() {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 0x100000000;
    };
  }

  const TOKENS = [
    "*", "**", "***", "~~", "`", "!", "[", "]", "(", ")",
    "https://", "example.com", "u", "https://u`x`", "https://u**x**",
    "&", "<", ">", '"', "=",
    " ", "a", "b", "1",
    "\n", "あいう", "😀", // 改行 / 日本語 / サロゲートペア（絵文字）
  ];

  function randomRaw(rng) {
    const len = Math.floor(rng() * 14);
    let out = "";
    for (let i = 0; i < len; i++) {
      out += TOKENS[Math.floor(rng() * TOKENS.length)];
    }
    return out;
  }

  // シードは固定のまま複数本走らせ、単一シードの偏りに依存しないようにする
  const SEEDS = [1, 7, 42, 1234, 20260828];
  const ITERATIONS = 4000;

  for (const seed of SEEDS) {
    test(`fuzz: シード ${seed} で ${ITERATIONS} 件のランダム入力を検証`, () => {
      const rng = makeRng(seed);
      for (let n = 0; n < ITERATIONS; n++) {
        const raw = randomRaw(rng);
        const context = () => `seed=${seed} raw=${JSON.stringify(raw)} (iteration ${n})`;

        const segments = inlineSegments(raw);

        let cursor = 0;
        for (const seg of segments) {
          assert.equal(seg.srcStart, cursor, context());
          assert.ok(seg.srcEnd > seg.srcStart, context());
          cursor = seg.srcEnd;
        }
        assert.equal(cursor, raw.length, context());

        const joinedSrc = segments.map((s) => raw.slice(s.srcStart, s.srcEnd)).join("");
        assert.equal(joinedSrc, raw, context());

        const joinedHtml = segments.map((s) => s.html).join("");
        assert.equal(joinedHtml, inlineMarkdown(escapeHtml(raw)), context());

        for (const seg of segments) {
          assert.equal(seg.visibleText, independentTextContent(seg.html), context());
        }
      }
    });
  }
});
