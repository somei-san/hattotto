const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

global.escapeHtml = require("../../src/utils.js").escapeHtml;
const { renderMarkdown } = require("../../src/markdown.js");

// ── Markdown 複合パターン ────────────────────────────────────

describe("renderMarkdown — 複合パターン", () => {
  test("ネストされたリスト（2段階）", () => {
    const html = renderMarkdown("- item\n  - nested");
    assert.match(html, /class="md-bullet"/);
    // 2つの bullet が存在
    const count = (html.match(/md-bullet/g) || []).length;
    assert.equal(count, 2);
  });

  test("ネストされたリスト（3段階）", () => {
    const html = renderMarkdown("- a\n  - b\n    - c");
    const count = (html.match(/md-bullet/g) || []).length;
    assert.equal(count, 3);
  });

  test("チェックボックス + 番号リスト混在", () => {
    const html = renderMarkdown("- [ ] task\n1. ordered");
    assert.match(html, /md-check/);
    assert.match(html, /md-ordered/);
  });

  test("引用ブロック + インライン装飾", () => {
    const html = renderMarkdown("> **bold** and *italic*");
    assert.match(html, /md-blockquote/);
    assert.match(html, /<strong>/);
    assert.match(html, /<em>/);
  });

  test("見出し + リスト + チェックボックスの連続", () => {
    const text = "# Title\n- item\n- [ ] task\n- [x] done";
    const html = renderMarkdown(text);
    assert.match(html, /md-h1/);
    assert.match(html, /md-bullet/);
    assert.match(html, /md-check/);
    // done のチェックボックスは checked
    assert.match(html, /checked/);
  });

  test("コードブロック内の Markdown 記号は処理されない", () => {
    const text = "```\n# not a heading\n- not a list\n```";
    const html = renderMarkdown(text);
    assert.doesNotMatch(html, /md-h1/);
    assert.doesNotMatch(html, /md-bullet/);
    assert.match(html, /md-codeblock/);
  });

  test("インラインコード内の装飾は処理されない", () => {
    const html = renderMarkdown("`**not bold**`");
    assert.doesNotMatch(html, /<strong>/);
    assert.match(html, /<code>/);
  });

  test("番号リストの自動採番（連番）", () => {
    const text = "1. first\n1. second\n1. third";
    const html = renderMarkdown(text);
    // 各アイテムが異なる番号を持つ
    assert.match(html, />1\.<\/span>/);
    assert.match(html, />2\.<\/span>/);
    assert.match(html, />3\.<\/span>/);
  });

  test("区切り線（---）", () => {
    const html = renderMarkdown("before\n---\nafter");
    assert.match(html, /<hr/);
  });

  test("太字 + 斜体 + 取消線の組み合わせ", () => {
    const html = renderMarkdown("**bold** *italic* ~~strike~~");
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>italic<\/em>/);
    assert.match(html, /<del>strike<\/del>/);
  });

  test("リンク記法 [text](url)", () => {
    const html = renderMarkdown("[Google](https://google.com)");
    assert.match(html, /href="https:\/\/google\.com"/);
    assert.match(html, />Google<\/a>/);
  });
});

// ── 生URL自動リンク ─────────────────────────────────────────

describe("renderMarkdown — 生URL自動リンク", () => {
  test("https:// URL がクリック可能なリンクに変換される", () => {
    const html = renderMarkdown("visit https://example.com today");
    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, />https:\/\/example\.com<\/a>/);
  });

  test("http:// URL もリンクに変換される", () => {
    const html = renderMarkdown("http://example.com");
    assert.match(html, /href="http:\/\/example\.com"/);
  });

  test("[text](url) 記法の URL は二重リンクにならない", () => {
    const html = renderMarkdown("[link](https://example.com)");
    // href が1つだけ存在する（二重にならない）
    const hrefCount = (html.match(/href=/g) || []).length;
    assert.equal(hrefCount, 1);
  });

  test("コードブロック内の URL はリンクにならない", () => {
    const html = renderMarkdown("`https://example.com`");
    assert.doesNotMatch(html, /href=/);
  });

  test("複数の URL が同一行にある場合、それぞれリンクになる", () => {
    const html = renderMarkdown("https://a.com and https://b.com");
    assert.match(html, /href="https:\/\/a\.com"/);
    assert.match(html, /href="https:\/\/b\.com"/);
  });
});
