const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

global.escapeHtml = require("../../src/utils.js").escapeHtml;
const { renderMarkdown } = require("../../src/markdown.js");

describe("renderMarkdown — fenced code block", () => {
  test("basic code block", () => {
    const html = renderMarkdown("```\nconst x = 1;\n```");
    assert.match(html, /<pre class="md-codeblock"/);
    assert.match(html, /<code>const x = 1;<\/code><\/pre>/);
  });

  test("code block with language specifier", () => {
    const html = renderMarkdown("```js\nlet y = 2;\n```");
    assert.match(html, /<pre class="md-codeblock"/);
    assert.match(html, /<code>let y = 2;<\/code><\/pre>/);
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

  test("unclosed code block still renders", () => {
    const html = renderMarkdown("```\nunclosed code");
    assert.match(html, /<pre class="md-codeblock"/);
    assert.match(html, /<code>unclosed code<\/code><\/pre>/);
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
