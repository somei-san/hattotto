const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { escapeHtml } = require("../../src/utils.js");

describe("escapeHtml", () => {
  test("& → &amp;", () => {
    assert.equal(escapeHtml("&"), "&amp;");
  });

  test("< → &lt;", () => {
    assert.equal(escapeHtml("<"), "&lt;");
  });

  test("> → &gt;", () => {
    assert.equal(escapeHtml(">"), "&gt;");
  });

  test('" はエスケープ対象外（属性値としてではなくテキストノードとして使われる）', () => {
    assert.equal(escapeHtml('"'), '"');
  });

  test("' はエスケープ対象外", () => {
    assert.equal(escapeHtml("'"), "'");
  });

  test("空文字はそのまま空文字", () => {
    assert.equal(escapeHtml(""), "");
  });

  test("エスケープ対象を含まない文字列はそのまま", () => {
    assert.equal(escapeHtml("hello world"), "hello world");
  });

  test("既にエスケープ済みの文字列は二重にエスケープする", () => {
    // escapeHtml は HTML パーサではなく単純な文字置換なので、入力がすでに実体参照でも
    // その `&` をさらにエスケープする（&lt; → &amp;lt;）
    assert.equal(escapeHtml("&lt;"), "&amp;lt;");
  });

  test("& を先に変換するため、< / > の変換結果と相互汚染しない", () => {
    // 3 段階の置換を & → < → > の順で適用する。先に < を &lt; に変換してしまうと、
    // その中の & が後段の & 置換で再度エスケープされ &amp;lt; になってしまうが、
    // 実装は & を最初に処理するのでこの汚染は起きない
    assert.equal(escapeHtml("<&>"), "&lt;&amp;&gt;");
  });

  test("複数種の記号が混在していてもすべて変換する", () => {
    assert.equal(escapeHtml("a<b>c&d"), "a&lt;b&gt;c&amp;d");
  });
});
