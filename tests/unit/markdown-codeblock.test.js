const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

global.escapeHtml = require("../../src/utils.js").escapeHtml;
const { renderMarkdown, scanFenceRanges } = require("../../src/markdown.js");

describe("renderMarkdown — fenced code block", () => {
  test("basic code block", () => {
    const html = renderMarkdown("```\nconst x = 1;\n```");
    assert.match(html, /<pre class="md-codeblock"/);
    assert.match(html, /<code>const x = 1;<\/code><\/pre>/);
  });

  test("code block with language specifier renders as literal text, not a code block", () => {
    const html = renderMarkdown("```js\nlet y = 2;\n```");
    assert.doesNotMatch(html, /md-codeblock/);
    assert.match(html, /<div class="md-line" data-line="0">```js<\/div>/);
    assert.match(html, /<div class="md-line" data-line="1">let y = 2;<\/div>/);
    // 2 行目の ``` は下に何も無いので未クローズの開きフェンス候補としてリテラル
    assert.match(html, /<div class="md-line" data-line="2">```<\/div>/);
  });

  test("末尾の内容行が空のときは <br> フィラーで行ボックスを確保する", () => {
    // <pre> のテキストが "\n" で終わっても末尾の改行は行ボックスを作らず、
    // 空行が描画されずキャレットも置けないため
    const html = renderMarkdown("```\ncode\n\n```");
    assert.match(html, /<code>code\n<br><\/code><\/pre>/);
  });

  test("内容が空行 1 つだけのコードブロックも <br> フィラーを持つ", () => {
    const html = renderMarkdown("```\n\n```");
    assert.match(html, /<code><br><\/code><\/pre>/);
  });

  test("末尾の内容行が空でなければ <br> フィラーは入らない", () => {
    const html = renderMarkdown("```\ncode\n```");
    assert.match(html, /<code>code<\/code><\/pre>/);
  });

  test("fence spans the source lines from opening to closing backticks", () => {
    const html = renderMarkdown("text\n```\ncode\n```");
    assert.match(html, /<pre class="md-codeblock" data-line="1" data-line-end="3">/);
  });

  test("markdown inside code block is not parsed", () => {
    const html = renderMarkdown("```\n# not a heading\n**not bold**\n- not a list\n```");
    assert.match(html, /<pre class="md-codeblock"/);
    assert.doesNotMatch(html, /md-h1/);
    assert.doesNotMatch(html, /<strong>/);
    assert.doesNotMatch(html, /md-bullet/);
  });

  test("HTML is escaped inside code block", () => {
    const html = renderMarkdown("```\n<div>test</div>\n```");
    assert.match(html, /&lt;div&gt;test&lt;\/div&gt;/);
  });

  test("multiple code blocks", () => {
    const html = renderMarkdown("text\n```\nblock1\n```\nmiddle\n```\nblock2\n```");
    const matches = html.match(/md-codeblock/g);
    assert.equal(matches.length, 2);
    assert.match(html, /block1/);
    assert.match(html, /block2/);
    assert.match(html, /md-line/);
  });

  test("unclosed fence with content below renders as literal text, not a code block", () => {
    const html = renderMarkdown("```\nunclosed code");
    assert.doesNotMatch(html, /md-codeblock/);
    assert.match(html, /<div class="md-line" data-line="0">```<\/div>/);
    assert.match(html, /<div class="md-line" data-line="1">unclosed code<\/div>/);
  });

  test("unclosed fence with no content below renders as literal text, not a code block", () => {
    const html = renderMarkdown("```\nunclosed code\n```\nmore\n```");
    // 最後の ``` は閉じ相手が無いので、下が空でもコードブロック化せずリテラル行のまま
    const matches = html.match(/md-codeblock/g);
    assert.equal(matches.length, 1);
    assert.match(html, /<div class="md-line" data-line="4">```<\/div>/);
  });

  test("empty code block", () => {
    const html = renderMarkdown("```\n```");
    assert.match(html, /<pre class="md-codeblock"/);
    assert.match(html, /<code><\/code><\/pre>/);
  });

  test("code block preserves multiple lines", () => {
    const html = renderMarkdown("```\nline1\nline2\nline3\n```");
    assert.match(html, /line1\nline2\nline3/);
  });

  test("normal markdown before and after code block", () => {
    const html = renderMarkdown("# Title\n```\ncode\n```\n- item");
    assert.match(html, /md-h1/);
    assert.match(html, /md-codeblock/);
    assert.match(html, /md-bullet/);
  });
});

describe("scanFenceRanges", () => {
  test("closed fence: range keyed by opening line, closed true", () => {
    const ranges = scanFenceRanges(["```", "code", "```"]);
    assert.deepEqual(ranges.get(0), { end: 2, closed: true });
    assert.equal(ranges.size, 1);
  });

  test("unclosed with non-empty content below: no range (literal)", () => {
    const ranges = scanFenceRanges(["```", "code"]);
    assert.equal(ranges.size, 0);
  });

  test("unclosed with only empty lines below: no range (literal)", () => {
    const ranges = scanFenceRanges(["```", "", ""]);
    assert.equal(ranges.size, 0);
  });

  test("unclosed with nothing below (last line): no range (literal)", () => {
    const ranges = scanFenceRanges(["```"]);
    assert.equal(ranges.size, 0);
  });

  test("multiple independent fences", () => {
    const ranges = scanFenceRanges(["```", "a", "```", "text", "```", "b", "```"]);
    assert.deepEqual(ranges.get(0), { end: 2, closed: true });
    assert.deepEqual(ranges.get(4), { end: 6, closed: true });
    assert.equal(ranges.size, 2);
  });

  test("language specifier line is never an opening fence, even when a closer follows", () => {
    const ranges = scanFenceRanges(["```aaa", "bbb", "```"]);
    assert.equal(ranges.size, 0);
  });

  test("language specifier line with content below but no closer: no range (literal)", () => {
    const ranges = scanFenceRanges(["```aaa", "bbb", "```", "ccc"]);
    assert.equal(ranges.size, 0);
  });

  test("bare closer after a language specifier line becomes an opening fence if closed further down", () => {
    // 1 行目 "```aaa" は言語指定つきなので開きフェンス候補にならずリテラル。3 行目の素の
    // "```" が新たな開きフェンス候補となり、5 行目の "```" で閉じてブロックが成立する
    const ranges = scanFenceRanges(["```aaa", "bbb", "```", "ccc", "```"]);
    assert.deepEqual(ranges.get(2), { end: 4, closed: true });
    assert.equal(ranges.size, 1);
  });
});
