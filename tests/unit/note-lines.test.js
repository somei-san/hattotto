const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  blockOffset,
  markerLength,
  getAutoPrefix,
  isEmptyListItem,
  CHECKBOX_RE,
} = require("../../src/note-lines.js");

describe("getAutoPrefix", () => {
  // ── Bullet lists ────────────────────────────────────────
  test("- item → '- '", () => {
    assert.equal(getAutoPrefix("- item"), "- ");
  });

  test("* item → '* '", () => {
    assert.equal(getAutoPrefix("* item"), "* ");
  });

  // ── Checkboxes ──────────────────────────────────────────
  test("- [ ] task → '- [ ] '", () => {
    assert.equal(getAutoPrefix("- [ ] task"), "- [ ] ");
  });

  test("- [x] done → '- [ ] ' (unchecked continuation)", () => {
    assert.equal(getAutoPrefix("- [x] done"), "- [ ] ");
  });

  // ── Ordered list ────────────────────────────────────────
  test("1. item → '2. '", () => {
    assert.equal(getAutoPrefix("1. item"), "2. ");
  });

  test("9. item → '10. '", () => {
    assert.equal(getAutoPrefix("9. item"), "10. ");
  });

  // ── Blockquote ──────────────────────────────────────────
  test("> quote → '> '", () => {
    assert.equal(getAutoPrefix("> quote"), "> ");
  });

  // ── Non-matching lines ──────────────────────────────────
  test("plain text → null", () => {
    assert.equal(getAutoPrefix("plain text"), null);
  });

  test("# heading → null", () => {
    assert.equal(getAutoPrefix("# heading"), null);
  });

  test("empty string → null", () => {
    assert.equal(getAutoPrefix(""), null);
  });

  // ── Indented lines ────────────────────────────────
  test("'  - item' → '  - ' (preserves indent)", () => {
    assert.equal(getAutoPrefix("  - item"), "  - ");
  });

  test("'  * item' → '  * ' (preserves indent)", () => {
    assert.equal(getAutoPrefix("  * item"), "  * ");
  });

  test("'  - [ ] task' → '  - [ ] ' (preserves indent)", () => {
    assert.equal(getAutoPrefix("  - [ ] task"), "  - [ ] ");
  });

  test("'  - [x] done' → '  - [ ] ' (preserves indent, unchecked)", () => {
    assert.equal(getAutoPrefix("  - [x] done"), "  - [ ] ");
  });

  test("'  1. item' → '  2. ' (preserves indent)", () => {
    assert.equal(getAutoPrefix("  1. item"), "  2. ");
  });

  test("'    > quote' → '    > ' (preserves indent)", () => {
    assert.equal(getAutoPrefix("    > quote"), "    > ");
  });

  test("'  plain text' → null (indent but no prefix)", () => {
    assert.equal(getAutoPrefix("  plain text"), null);
  });
});

describe("isEmptyListItem", () => {
  // ── Should cancel (empty prefix) ───────────────────────
  test("'- ' → true", () => {
    assert.equal(isEmptyListItem("- "), true);
  });

  test("'* ' → true", () => {
    assert.equal(isEmptyListItem("* "), true);
  });

  test("'- [ ] ' → true", () => {
    assert.equal(isEmptyListItem("- [ ] "), true);
  });

  test("'1. ' → true", () => {
    assert.equal(isEmptyListItem("1. "), true);
  });

  test("'> ' → true", () => {
    assert.equal(isEmptyListItem("> "), true);
  });

  // ── Should NOT cancel (has content) ────────────────────
  test("'- text' → false", () => {
    assert.equal(isEmptyListItem("- text"), false);
  });

  test("'1. item' → false", () => {
    assert.equal(isEmptyListItem("1. item"), false);
  });

  test("'> quoted' → false", () => {
    assert.equal(isEmptyListItem("> quoted"), false);
  });

  // ── Non-list lines ─────────────────────────────────────
  test("plain text → false", () => {
    assert.equal(isEmptyListItem("plain text"), false);
  });

  test("'# heading' → false", () => {
    assert.equal(isEmptyListItem("# heading"), false);
  });

  // ── Indented empty list items ─────────────────────
  test("'  - ' → true (indented empty bullet)", () => {
    assert.equal(isEmptyListItem("  - "), true);
  });

  test("'  * ' → true (indented empty bullet)", () => {
    assert.equal(isEmptyListItem("  * "), true);
  });

  test("'  - [ ] ' → true (indented empty checkbox)", () => {
    assert.equal(isEmptyListItem("  - [ ] "), true);
  });

  test("'  1. ' → true (indented empty ordered)", () => {
    assert.equal(isEmptyListItem("  1. "), true);
  });

  test("'  - item' → false (indented with content)", () => {
    assert.equal(isEmptyListItem("  - item"), false);
  });

  test("'  - [ ] task' → false (indented checkbox with content)", () => {
    assert.equal(isEmptyListItem("  - [ ] task"), false);
  });
});

describe("CHECKBOX_RE pattern", () => {
  const matchCheckbox = (text) => {
    const m = text.match(CHECKBOX_RE);
    return m ? [m[1], m[2]] : null;
  };

  test("- [] matches", () => {
    assert.deepEqual(matchCheckbox("- []"), ["-", ""]);
  });

  test("- [x] matches", () => {
    assert.deepEqual(matchCheckbox("- [x]"), ["-", "x"]);
  });

  test("- [X] matches", () => {
    assert.deepEqual(matchCheckbox("- [X]"), ["-", "X"]);
  });

  test("- [ ] does not match (already correct format)", () => {
    assert.equal(matchCheckbox("- [ ]"), null);
  });

  test("* [] matches", () => {
    assert.deepEqual(matchCheckbox("* []"), ["*", ""]);
  });

  test("* [x] matches", () => {
    assert.deepEqual(matchCheckbox("* [x]"), ["*", "x"]);
  });

  test("* [X] matches", () => {
    assert.deepEqual(matchCheckbox("* [X]"), ["*", "X"]);
  });

  test("-[] (no space) matches", () => {
    assert.deepEqual(matchCheckbox("-[]"), ["-", ""]);
  });

  test("-[x] (no space) matches", () => {
    assert.deepEqual(matchCheckbox("-[x]"), ["-", "x"]);
  });

  test("*[] (no space) matches", () => {
    assert.deepEqual(matchCheckbox("*[]"), ["*", ""]);
  });

  test("*[x] (no space) matches", () => {
    assert.deepEqual(matchCheckbox("*[x]"), ["*", "x"]);
  });

  test("already correct '- [ ] ' does not match (trailing space+text)", () => {
    assert.equal(matchCheckbox("- [ ] "), null);
  });

  test("plain text does not match", () => {
    assert.equal(matchCheckbox("hello"), null);
  });

  test("no bullet does not match", () => {
    assert.equal(matchCheckbox("[]"), null);
  });
});

describe("markerLength", () => {
  test("見出しはインデントが無いときだけマーカーとして数える", () => {
    assert.equal(markerLength("# heading"), 2);
    assert.equal(markerLength("  # heading"), 2);
  });

  test("リスト・チェックボックス・引用・番号付き", () => {
    assert.equal(markerLength("- item"), 2);
    assert.equal(markerLength("* item"), 2);
    assert.equal(markerLength("- [ ] task"), 6);
    assert.equal(markerLength("- [x] task"), 6);
    assert.equal(markerLength("> quote"), 2);
    assert.equal(markerLength("1. item"), 3);
    assert.equal(markerLength("10. item"), 4);
  });

  test("インデントはマーカーに加算される", () => {
    assert.equal(markerLength("  - item"), 4);
    assert.equal(markerLength("    - [ ] task"), 10);
  });

  test("マーカーが無ければインデントの長さだけ", () => {
    assert.equal(markerLength("plain text"), 0);
    assert.equal(markerLength("  plain text"), 2);
    assert.equal(markerLength(""), 0);
  });
});

describe("blockOffset", () => {
  const lines = ["abc", "de", "fghi"];

  test("先頭行は列がそのままオフセットになる", () => {
    assert.equal(blockOffset(lines, 0, 0), 0);
    assert.equal(blockOffset(lines, 0, 3), 3);
  });

  test("2 行目以降は前の行の長さと改行 1 文字を足す", () => {
    assert.equal(blockOffset(lines, 1, 0), 4);
    assert.equal(blockOffset(lines, 2, 2), 9);
  });

  test("空行も改行 1 文字として数える", () => {
    assert.equal(blockOffset(["", "x"], 1, 1), 2);
  });
});
