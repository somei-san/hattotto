const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { escapeHtml } = require("../../src/utils.js");
global.escapeHtml = escapeHtml;
const { lineConversionOccurred, inlineKindCounts } = require("../../src/markdown.js");

// lineConversionOccurred は note.js の checkpointConversion（undo チェックポイントのトリガー）が
// 使う純粋関数。before/after は checkpointConversion が渡す形（1 文字挿入の前後、改行を含まない
// 1 行）に揃えてある。フェンス内容行の除外はこの関数の責務ではなく呼び出し側
// （note.js の checkpointConversion、findBlock 判定）が担う（末尾の describe 参照）。

describe("lineConversionOccurred — ブロック種別ごとの変換検出", () => {
  const cases = [
    { name: "見出し1(h1): # → # ", before: "#", after: "# ", expected: true },
    { name: "見出し2(h2): ## → ## ", before: "##", after: "## ", expected: true },
    { name: "見出し3(h3): ### → ### ", before: "###", after: "### ", expected: true },
    { name: "箇条書き: - → - ", before: "-", after: "- ", expected: true },
    { name: "引用: > → > ", before: ">", after: "> ", expected: true },
    { name: "順序リスト: 1. → 1. ", before: "1.", after: "1. ", expected: true },
    { name: "チェックボックス補完: - [ ] → - [ ] ", before: "- [ ]", after: "- [ ] ", expected: true },
    { name: "チェック済み補完: - [x] → - [x] ", before: "- [x]", after: "- [x] ", expected: true },
    { name: "区切り線(hr): -- → ---", before: "--", after: "---", expected: true },
  ];
  for (const { name, before, after, expected } of cases) {
    test(name, () => assert.equal(lineConversionOccurred(before, after), expected));
  }
});

describe("lineConversionOccurred — empty/text への遷移は対象外", () => {
  const cases = [
    { name: "空行への最初の1文字目は変換ではない", before: "", after: "a", expected: false },
    { name: "装飾解除の逆方向（text→empty）も対象外", before: "a", after: "", expected: false },
  ];
  for (const { name, before, after, expected } of cases) {
    test(name, () => assert.equal(lineConversionOccurred(before, after), expected));
  }
});

describe("lineConversionOccurred — インライン装飾の kind 増加", () => {
  const cases = [
    { name: "太字の閉じ確定: **bold* → **bold**", before: "**bold*", after: "**bold**", expected: true },
    { name: "斜字の閉じ確定: *a → *a*", before: "*a", after: "*a*", expected: true },
    { name: "コードの閉じ確定: `a → `a`", before: "`a", after: "`a`", expected: true },
    { name: "取り消し線の閉じ確定: ~~a → ~~a~~", before: "~~a", after: "~~a~~", expected: true },
    { name: "リンクの閉じ確定: [a](https://e → [a](https://e)", before: "[a](https://e", after: "[a](https://e)", expected: true },
    { name: "装飾を伴わないプレーンタイピングは対象外", before: "hello", after: "hello!", expected: false },
  ];
  for (const { name, before, after, expected } of cases) {
    test(name, () => assert.equal(lineConversionOccurred(before, after), expected));
  }
});

// classifyLine の contentStart（マーカー長）を経由して、マーカーを除いた内容だけを
// inlineKindCounts に渡すことの検証。マーカー込みで渡すと、行頭の `* ` のようなマーカーの
// 先頭 `*` が ITALIC_RE に装飾の一部として食い込まれ、実際の描画（renderInline が受け取る
// 内容も同じくマーカーを除いた文字列）とずれる。
describe("lineConversionOccurred — マーカー込みで渡すと生じるずれの回帰", () => {
  test("箇条書き行の内容側で新規に斜字が成立する（マーカーの `*` を巻き込まない）", () => {
    // 内容は "a *b" → "a *b*"。行頭の `* ` マーカーを除けば斜字が新規成立している
    assert.equal(lineConversionOccurred("* a *b", "* a *b*"), true);
  });

  test("マーカーの `*` と内容の `*` が対にならず、斜字は成立していない", () => {
    // 内容は "a " → "a *"。開き `*` が 1 つ増えただけで閉じておらず、斜字は未成立
    assert.equal(lineConversionOccurred("* a ", "* a *"), false);
  });
});

// lineConversionOccurred はブロック・インライン装飾の判定だけを行う純粋関数で、行がフェンス
// 内容行かどうかは知らない（引数の line は checkpointConversion 経由で渡る 1 行の raw だけで、
// 前後の行やフェンス範囲を持たない）。フェンス内容行を対象外にするのは、findBlock で描画済み
// ブロックを見られる呼び出し側（note.js の checkpointConversion）の責務であり、この関数自身は
// フェンス内容行に対しても通常の行と同じ判定を返す。
describe("lineConversionOccurred — フェンス内容行の除外は呼び出し側の責務", () => {
  test("フェンス内容行を想定した入力でも、この関数自体は通常どおり検出する", () => {
    assert.equal(lineConversionOccurred("", "- "), true);
  });
});

describe("inlineKindCounts", () => {
  test("装飾が無ければ空", () => {
    assert.deepEqual(inlineKindCounts("hello"), new Map());
  });

  test("kind ごとの出現数を数える", () => {
    const counts = inlineKindCounts("**a** *b* **c**");
    assert.equal(counts.get("bold"), 2);
    assert.equal(counts.get("italic"), 1);
  });
});
