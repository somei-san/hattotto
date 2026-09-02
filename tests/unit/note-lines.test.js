const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

// visibleOffsetToRawOffset・revealTargetAt は inlineSegments/isRevealableKind をブラウザの
// グローバルスコープ経由で参照する（note.html の読み込み順で markdown.js → note-lines.js の
// 順に読まれるのを前提にしている）。markdown-codeblock.test.js の escapeHtml と同じ作法で、
// require 前に global へ生やす
global.escapeHtml = require("../../src/utils.js").escapeHtml;
const markdownModule = require("../../src/markdown.js");
global.inlineSegments = markdownModule.inlineSegments;
global.isRevealableKind = markdownModule.isRevealableKind;

const {
  blockOffset,
  markerLength,
  getAutoPrefix,
  isEmptyListItem,
  CHECKBOX_RE,
  isImageOnlyLine,
  isCheckboxLine,
  visibleOffsetToRawOffset,
  visibleOffsetFromRawOffset,
  revealTargetAt,
  inlineDecorationKeepRanges,
  deletionSurvivingFragment,
  widenRangeForEmptiedDecorations,
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

describe("isImageOnlyLine", () => {
  const PATH = "images/00000000-0000-4000-8000-000000000001.png";

  test("画像記法だけの行 → true", () => {
    assert.equal(isImageOnlyLine(`![](${PATH})`), true);
  });

  test("alt 付き → true", () => {
    assert.equal(isImageOnlyLine(`![説明](${PATH})`), true);
  });

  test("幅指定付き → true", () => {
    assert.equal(isImageOnlyLine(`![|300](${PATH})`), true);
  });

  test("alt + 幅指定付き → true", () => {
    assert.equal(isImageOnlyLine(`![説明|300](${PATH})`), true);
  });

  test("前後に空白のみ → true", () => {
    assert.equal(isImageOnlyLine(`  ![](${PATH})  `), true);
  });

  test("拡張子違い（jpg/jpeg/gif/webp）も true", () => {
    for (const ext of ["jpg", "jpeg", "gif", "webp"]) {
      const path = `images/00000000-0000-4000-8000-000000000001.${ext}`;
      assert.equal(isImageOnlyLine(`![](${path})`), true, ext);
    }
  });

  test("テキストと混在 → false", () => {
    assert.equal(isImageOnlyLine(`text ![](${PATH})`), false);
    assert.equal(isImageOnlyLine(`![](${PATH}) text`), false);
  });

  test("複数画像 → false", () => {
    assert.equal(isImageOnlyLine(`![](${PATH})![](${PATH})`), false);
  });

  test("リモート URL の画像 → false（images/ 相対パスのみ対象）", () => {
    assert.equal(isImageOnlyLine("![](https://example.com/pic.png)"), false);
  });

  test("プレーンテキスト → false", () => {
    assert.equal(isImageOnlyLine("plain text"), false);
  });

  test("空行 → false", () => {
    assert.equal(isImageOnlyLine(""), false);
  });

  test("alt が「リンク」を含む文字列でも、リンクではなく画像記法単体なら true", () => {
    // alt はただの文字列。「リンク先」という語が入っていても記法自体は ![alt](images/...) のまま
    assert.equal(isImageOnlyLine(`![リンク先](${PATH})`), true);
  });

  test("リンクで包まれた画像（[![](p)](url)）は画像記法単体ではないので false", () => {
    assert.equal(isImageOnlyLine(`[![](${PATH})](https://example.com)`), false);
  });

  test("不正な uuid 形状のパス → false", () => {
    assert.equal(isImageOnlyLine("![](images/not-a-uuid.png)"), false);
  });

  test("パストラバーサル細工 → false", () => {
    assert.equal(isImageOnlyLine("![](images/../notes.json)"), false);
  });
});

describe("visibleOffsetToRawOffset", () => {
  // ── プレーン行: 可視文字と raw 文字が 1:1 ─────────────────
  test("プレーン行は可視オフセットがそのまま raw オフセット", () => {
    const raw = "hello world";
    for (let i = 0; i <= raw.length; i++) {
      assert.equal(visibleOffsetToRawOffset(raw, i, false), i);
      assert.equal(visibleOffsetToRawOffset(raw, i, true), i);
    }
  });

  test("空文字列は 0 を返す", () => {
    assert.equal(visibleOffsetToRawOffset("", 0, false), 0);
  });

  // ── 装飾セグメントの両端（自然な境界） ─────────────────
  test("装飾セグメントの開始境界（within=0）は srcStart", () => {
    // "**bold** tail" → 可視は "bold tail"。可視 0 は raw 0（"**" の直前）
    assert.equal(visibleOffsetToRawOffset("**bold** tail", 0, false), 0);
  });

  test("装飾セグメントの終了境界（within=segLen）は srcEnd", () => {
    // 可視 "bold"（4 文字）の直後 = raw の "**bold**"（8 文字）の直後
    assert.equal(visibleOffsetToRawOffset("**bold** tail", 4, true), 8);
    assert.equal(visibleOffsetToRawOffset("**bold** tail", 4, false), 8);
  });

  // ── 装飾セグメント内部（charMap による厳密対応） ─────────────
  test("装飾セグメント内部は charMap で厳密対応する（isEnd に関わらず同じ raw オフセット）", () => {
    // 可視 "bo|ld"（2 文字目、"**bold**" の内部）→ "bold" は raw[2,6) なので raw 4
    assert.equal(visibleOffsetToRawOffset("**bold** tail", 2, false), 4);
    assert.equal(visibleOffsetToRawOffset("**bold** tail", 2, true), 4);
  });

  test("装飾セグメント内部の全位置が raw と 1:1 対応する（往復整合）", () => {
    const raw = "**bold** tail";
    // "bold" の厳密に内部（両端の境界 0・4 は charMap でなく srcStart/srcEnd を返す規約のため対象外）の
    // 可視位置 1..3 は raw[3..5) に厳密対応する
    for (let i = 1; i <= 3; i++) {
      assert.equal(visibleOffsetToRawOffset(raw, i, false), 2 + i);
      assert.equal(visibleOffsetToRawOffset(raw, i, true), 2 + i);
    }
  });

  test("取り消し線 ~~del~~ でも同様に厳密対応する", () => {
    // "del" は raw[2,5) なので可視 1（"d" の直後）は raw 3
    assert.equal(visibleOffsetToRawOffset("~~del~~", 1, false), 3);
    assert.equal(visibleOffsetToRawOffset("~~del~~", 1, true), 3);
  });

  // ── 画像記法: 可視文字数 0 ─────────────────────────────
  test("画像記法は可視文字を持たず、直前の可視オフセットが raw 上の画像記法の開始位置に解決される", () => {
    const raw = "before ![alt](images/00000000-0000-4000-8000-000000000001.png) after";
    // "before " は可視 7 文字（raw も同じ 7 文字）、続く画像は可視 0 文字を挟むので、
    // "before " の直後（可視オフセット 7）は isEnd の向きに関わらず同じ raw オフセット 7 に解決される
    // （画像自体には選び取れる可視位置が無いため、開始端・終了端の区別が意味を持たない）
    assert.equal(visibleOffsetToRawOffset(raw, 7, false), 7);
    assert.equal(visibleOffsetToRawOffset(raw, 7, true), 7);
  });

  // ── コードスパン ────────────────────────────────────────
  test("`code` の内部も charMap で厳密対応する", () => {
    const raw = "see `foo` here";
    // 可視 "foo" は raw の "`foo`"（backtick を除く "foo" は raw[5,8)）に対応
    assert.equal(visibleOffsetToRawOffset(raw, 4, false), 4); // "see " の直後は 1:1
    assert.equal(visibleOffsetToRawOffset(raw, 7, true), 9); // "foo" の直後（segLen 到達）→ srcEnd
    assert.equal(visibleOffsetToRawOffset(raw, 5, true), 6); // "foo" の内部1文字目 → raw[5]+1
    assert.equal(visibleOffsetToRawOffset(raw, 5, false), 6); // isEnd に関わらず同じ raw オフセット
  });

  // ── HTML エンティティを生む文字 ─────────────────────────
  test("& < > を含む行でも可視オフセットは raw 1 文字ずつに対応する", () => {
    const raw = "a & b < c > d";
    for (let i = 0; i <= raw.length; i++) {
      assert.equal(visibleOffsetToRawOffset(raw, i, false), i);
    }
  });

  // ── 可視末尾を超えるオフセット ───────────────────────────
  test("可視文字数の合計を超えるオフセットは raw 末尾にクランプする", () => {
    const raw = "**bold**";
    assert.equal(visibleOffsetToRawOffset(raw, 999, false), raw.length);
  });
});

describe("visibleOffsetFromRawOffset", () => {
  // ── プレーン行: raw オフセットがそのまま可視オフセット ─────
  test("プレーン行は raw オフセットがそのまま可視オフセット", () => {
    const raw = "hello world";
    for (let i = 0; i <= raw.length; i++) {
      assert.equal(visibleOffsetFromRawOffset(raw, i), i);
    }
  });

  test("空文字列は 0 を返す", () => {
    assert.equal(visibleOffsetFromRawOffset("", 0), 0);
  });

  // ── 装飾セグメントの両端（visibleOffsetToRawOffset との往復） ─────
  test("装飾セグメントの開始境界（raw 0）は可視 0 ── visibleOffsetToRawOffset(raw, 0, false) の逆", () => {
    const raw = "**bold** tail";
    assert.equal(visibleOffsetToRawOffset(raw, 0, false), 0); // 既存の往路の確認
    assert.equal(visibleOffsetFromRawOffset(raw, 0), 0);
  });

  test("装飾セグメントの終了境界（raw 8）は可視 4 ── visibleOffsetToRawOffset(raw, 4, true) の逆", () => {
    const raw = "**bold** tail";
    assert.equal(visibleOffsetToRawOffset(raw, 4, true), 8); // 既存の往路の確認
    assert.equal(visibleOffsetFromRawOffset(raw, 8), 4);
  });

  test("装飾セグメントに続くプレーン部分の末尾（raw 13）は可視 9（\"bold tail\" の文字数）", () => {
    const raw = "**bold** tail";
    assert.equal(visibleOffsetFromRawOffset(raw, 13), "bold tail".length);
  });

  // ── 装飾セグメント内部（マーカー文字そのもの）への丸め ─────
  test("マーカー文字そのものの内部は、セグメント中央より手前なら開始側の可視境界へ丸める", () => {
    // "**bold**" の raw 1（"*" の 2 文字目、中央 4 より手前）→ 可視 0（開始側）
    assert.equal(visibleOffsetFromRawOffset("**bold** tail", 1), 0);
  });

  test("マーカー文字そのものの内部は、セグメント中央以降なら終了側の可視境界へ丸める", () => {
    // "**bold**" の raw 7（末尾の "*" の 1 文字目、中央 4 より奥）→ 可視 4（終了側）
    assert.equal(visibleOffsetFromRawOffset("**bold** tail", 7), 4);
  });

  test("取り消し線 ~~del~~ でも同様に丸める", () => {
    const raw = "~~del~~";
    assert.equal(visibleOffsetFromRawOffset(raw, 0), 0);
    assert.equal(visibleOffsetFromRawOffset(raw, 7), 3); // "del" の直後
  });

  // ── コードスパン: プレーン/装飾の継ぎ目は往路と厳密に一致する ─────
  test("`code` 直前のプレーン部分は raw と可視が 1:1 対応する", () => {
    const raw = "see `foo` here";
    assert.equal(visibleOffsetFromRawOffset(raw, 4), 4); // "see " の直後
  });

  test("`code` の終了境界（raw 9）は可視 7（\"see foo\" の直後）── visibleOffsetToRawOffset の逆", () => {
    const raw = "see `foo` here";
    assert.equal(visibleOffsetToRawOffset(raw, 7, true), 9); // 既存の往路の確認（コードスパンは isEnd に依らず境界へ丸める）
    assert.equal(visibleOffsetFromRawOffset(raw, 9), 7);
  });

  // ── 装飾セグメントの中身（charMap の範囲）は厳密対応する ─────
  test("装飾セグメントの中身に落ちた raw 位置は charMap で厳密対応する（マーカーの丸めとは別枠）", () => {
    // "**bold**" の raw 3（"bold" の内部、"b" の直後）→ 可視 1
    assert.equal(visibleOffsetFromRawOffset("**bold** tail", 3), 1);
  });

  test("装飾セグメントの中身は visibleOffsetToRawOffset と全位置で往復一致する", () => {
    const raw = "**bold** tail";
    // 中身の raw 範囲 [2,6] のうち、両端（マーカー直後・直前）は境界規約で srcStart/srcEnd に
    // 丸められるため往復一致の対象外。厳密に内部の raw 3..5 だけを確認する
    for (let raw_i = 3; raw_i <= 5; raw_i++) {
      const visible = visibleOffsetFromRawOffset(raw, raw_i);
      assert.equal(visibleOffsetToRawOffset(raw, visible, false), raw_i);
    }
  });

  test("`code` の中身も charMap で厳密対応する", () => {
    const raw = "see `foo` here";
    // raw 6（"foo" の "f" の直後）→ 可視 5（"see f" の直後）
    assert.equal(visibleOffsetFromRawOffset(raw, 6), 5);
  });

  // ── ネストした装飾は charMap を持たず現行の丸めへフォールバックする ─────
  test("ネストした装飾（bold の中に code）は charMap を持たず中央値丸めのまま", () => {
    const raw = "**bold `code` here**"; // srcStart=0, srcEnd=20, mid=10, 可視 "bold code here"（14文字）
    assert.equal(visibleOffsetFromRawOffset(raw, 5), 0); // mid より手前 → 開始側
    assert.equal(visibleOffsetFromRawOffset(raw, 15), 14); // mid 以降 → 終了側（segLen）
  });

  // ── リンクラベル・裸URLも charMap で厳密対応する ─────────
  test("リンクラベルの内部は charMap で厳密対応する", () => {
    const raw = "[label](https://example.com)";
    // ラベル "label" は raw[1,6)。可視 2（"la" の直後）→ raw 3
    assert.equal(visibleOffsetToRawOffset(raw, 2, false), 3);
    assert.equal(visibleOffsetFromRawOffset(raw, 3), 2);
  });

  test("裸URLの内部は charMap で厳密対応する", () => {
    const raw = "see https://example.com here";
    // 裸URLは raw[4,...) から始まる。"see " の直後（可視4）+ "https://"（8文字）＝可視12 → raw 12
    assert.equal(visibleOffsetToRawOffset(raw, 12, false), 12);
    assert.equal(visibleOffsetFromRawOffset(raw, 12), 12);
  });

  // ── マーカー上に落ちた raw 位置は同じ側の可視境界へ寄せる ─────
  test("リンクの閉じ記号（] や URL 部）に落ちた raw 位置はラベル末尾へ寄せる", () => {
    const raw = "[label](https://e.com)";
    // charMap の中身はラベル "label"（raw [1,6)）。それより奥はすべて可視末尾（5）
    assert.equal(visibleOffsetFromRawOffset(raw, 6), 5); // "]" の位置
    assert.equal(visibleOffsetFromRawOffset(raw, 7), 5); // "(" の位置
    assert.equal(visibleOffsetFromRawOffset(raw, 15), 5); // URL の内部
  });

  test("raw オフセットを右へ進めても可視オフセットは戻らない（単調性）", () => {
    const corpus = [
      "**bold** tail",
      "[label](https://e.com)",
      "see `foo` here",
      "~~del~~ x",
      "a **b** `c` [d](http://e) f",
      "**bold `code` here**",
      "see https://example.com here",
    ];
    for (const raw of corpus) {
      let prev = 0;
      for (let i = 0; i <= raw.length; i++) {
        const visible = visibleOffsetFromRawOffset(raw, i);
        assert.ok(visible >= prev, `${JSON.stringify(raw)} raw ${i}: 可視 ${visible} < 直前 ${prev}`);
        prev = visible;
      }
    }
  });

  // ── 可視末尾を超えるオフセット ───────────────────────────
  test("raw 文字数の合計を超えるオフセットは可視末尾相当にクランプする", () => {
    const raw = "**bold**";
    assert.equal(visibleOffsetFromRawOffset(raw, 999), "bold".length);
  });

  // ── 往復（プレーン区間はどの raw オフセットでも一致する） ─────
  test("プレーンセグメントは visibleOffsetToRawOffset と往復一致する", () => {
    const raw = "a & b < c > d";
    for (let i = 0; i <= raw.length; i++) {
      const visible = visibleOffsetFromRawOffset(raw, i);
      assert.equal(visibleOffsetToRawOffset(raw, visible, false), i);
    }
  });
});

// ── インライン生表示（reveal） ──────────────────────────────
// reveal 引数を渡すと、対象セグメントは可視 = raw の 1:1（マーカー込みの生テキストがそのまま
// 見える）になる。visibleOffsetToRawOffset/visibleOffsetFromRawOffset は inlineSegments(raw, reveal)
// を経由するだけなので、charMap が識別写像になっていることを確認すれば十分。
describe("visibleOffsetToRawOffset / visibleOffsetFromRawOffset — reveal 指定あり", () => {
  test("reveal 範囲内は可視オフセットと raw オフセットが 1:1（マーカー文字も含めて）", () => {
    const raw = "pre **bold** post";
    const reveal = { start: 4, end: 12 }; // "**bold**" の全体（マーカー込み）
    // reveal が無いと可視 5（"pre b" の直後）は raw 6（"bold" の "b" の直後）に丸まるが、
    // reveal 中は可視 5 がそのまま raw 5（"**bol" の直後）になる
    assert.equal(visibleOffsetToRawOffset(raw, 5, false, reveal), 5);
    assert.equal(visibleOffsetFromRawOffset(raw, 5, reveal), 5);
    for (let i = 0; i <= raw.length; i++) {
      assert.equal(visibleOffsetFromRawOffset(raw, i, reveal), i);
    }
  });

  test("reveal 範囲がどのセグメントにも一致しなければ通常どおり丸められる（編集でマーカーが崩れた後の想定）", () => {
    const raw = "pre bold post"; // 装飾が崩れてただのプレーンテキストになった後
    const staleReveal = { start: 4, end: 12 }; // もう存在しない旧セグメントの範囲
    assert.equal(visibleOffsetToRawOffset(raw, 5, false, staleReveal), 5); // プレーンなので 1:1 のまま変化なし
  });
});

describe("revealTargetAt", () => {
  test("太字の可視内部にキャレットがあれば装飾全体（マーカー込み）の raw 範囲を返す", () => {
    const raw = "pre **bold** post";
    assert.deepEqual(revealTargetAt(raw, 8), { start: 4, end: 12 }); // "**bo|ld**"
  });

  test("装飾の可視先頭（srcStart）は reveal 対象に含まれる", () => {
    assert.deepEqual(revealTargetAt("**bold**", 0), { start: 0, end: 8 });
  });

  test("装飾の可視末尾（srcEnd）は reveal 対象に含まれる", () => {
    assert.deepEqual(revealTargetAt("**bold**", 8), { start: 0, end: 8 });
  });

  test("装飾の外（前後のプレーン部分）は対象外", () => {
    const raw = "pre **bold** post";
    assert.equal(revealTargetAt(raw, 2), null); // "pr|e **bold**"
    assert.equal(revealTargetAt(raw, 15), null); // "**bold** po|st"
  });

  test("プレーンテキストのみの行は常に null", () => {
    assert.equal(revealTargetAt("hello world", 5), null);
  });

  test("イタリック・取り消し線・インラインコード・リンクも対象になる", () => {
    assert.deepEqual(revealTargetAt("*italic*", 4), { start: 0, end: 8 });
    assert.deepEqual(revealTargetAt("~~del~~", 4), { start: 0, end: 7 });
    assert.deepEqual(revealTargetAt("`code`", 3), { start: 0, end: 6 });
    const link = "[label](https://example.com)";
    assert.deepEqual(revealTargetAt(link, 3), { start: 0, end: link.length });
  });

  test("画像・裸URLは対象外（マーカーを隠す意味が無い）", () => {
    assert.equal(revealTargetAt("![alt](images/a.png)", 5), null);
    assert.equal(revealTargetAt("see https://example.com here", 10), null);
  });

  test("2 つの装飾が隣接する境界では手前（左）のセグメントを優先する", () => {
    const raw = "**a***b*"; // "**a**" [0,5) の直後に "*b*" [5,8) が続く
    assert.deepEqual(revealTargetAt(raw, 5), { start: 0, end: 5 });
  });

  test("ネストした装飾（charMap が無いセグメント）も外側の raw 範囲全体が対象になる", () => {
    const raw = "**bold `code` here**";
    assert.deepEqual(revealTargetAt(raw, 10), { start: 0, end: raw.length });
  });
});

// "abc **bold** def" の raw インデックス（インライン部＝行頭マーカーなし）:
// a0 b1 c2 sp3 *4 *5 b6 o7 l8 d9 *10 *11 sp12 d13 e14 f15
// 装飾セグメントは srcStart=4, srcEnd=12, 内容（charMap）は srcStart=6, len=4（"bold"）。
const BOLD_LINE = "abc **bold** def";

describe("inlineDecorationKeepRanges", () => {
  test("装飾の可視 1 文字目だけを覆う範囲 → 開きマーカーの raw 区間を保存対象にする", () => {
    // 可視 "b" だけ選択した場合の resolveSelectionBounds 相当（境界規約により lo は
    // srcStart(4) へスナップされ、hi は charMap 経由で内容内部の 7 になる）
    assert.deepEqual(inlineDecorationKeepRanges(BOLD_LINE, 4, 7), [[4, 6]]);
  });

  test("装飾の内容途中〜装飾の外まで覆う範囲 → 閉じマーカーの raw 区間を保存対象にする", () => {
    assert.deepEqual(inlineDecorationKeepRanges(BOLD_LINE, 7, 15), [[10, 12]]);
  });

  test("装飾全体（マーカー込み）を覆う範囲 → 保存対象なし（従来どおりマーカーごと削除）", () => {
    assert.deepEqual(inlineDecorationKeepRanges(BOLD_LINE, 4, 12), []);
  });

  test("装飾と重ならない範囲 → 保存対象なし", () => {
    assert.deepEqual(inlineDecorationKeepRanges(BOLD_LINE, 0, 4), []);
    assert.deepEqual(inlineDecorationKeepRanges(BOLD_LINE, 12, 16), []);
  });

  test("charMap を持たないセグメント（画像等）は対象外", () => {
    assert.deepEqual(inlineDecorationKeepRanges("see ![alt](images/a.png) here", 4, 25), []);
  });
});

describe("deletionSurvivingFragment — 部分選択マーカー保存の例", () => {
  test("例1: 可視「b」だけ削除 → 太字は維持され中身だけ削る（マーカーが挿入位置の前に残る）", () => {
    const result = deletionSurvivingFragment(BOLD_LINE, 4, 7);
    assert.deepEqual(result, { text: "**", insertOffset: 2 });
    // 呼び出し元（note.js の spliceSelectionRange）が組み立てる最終行と同じ形で検証する
    const line = BOLD_LINE.slice(0, 4) + result.text.slice(0, result.insertOffset)
      + result.text.slice(result.insertOffset) + BOLD_LINE.slice(7);
    assert.equal(line, "abc **old** def");
  });

  test("例2: 可視「old de」を削除 → 残った「b」がマーカー付きで残る", () => {
    const result = deletionSurvivingFragment(BOLD_LINE, 7, 15);
    assert.deepEqual(result, { text: "**", insertOffset: 0 });
    const line = BOLD_LINE.slice(0, 7) + result.text + BOLD_LINE.slice(15);
    assert.equal(line, "abc **b**f");
  });

  test("例3: 装飾全体を覆う削除は従来どおりマーカーごと消える", () => {
    const result = deletionSurvivingFragment(BOLD_LINE, 4, 12);
    assert.deepEqual(result, { text: "", insertOffset: 0 });
    const line = BOLD_LINE.slice(0, 4) + result.text + BOLD_LINE.slice(12);
    assert.equal(line, "abc  def");
  });

  test("例4: 装飾をまたぐ選択は両側それぞれの部分覆いセグメントのマーカーを保存する", () => {
    const line2 = "**bold** and *italic*";
    // 太字内容の途中（"bo|ld"）〜 斜字内容の途中（"ita|lic"）を削除
    const result = deletionSurvivingFragment(line2, 4, 17);
    assert.deepEqual(result, { text: "***", insertOffset: 0 });
    const rebuilt = line2.slice(0, 4) + result.text + line2.slice(17);
    assert.equal(rebuilt, "**bo***lic*");
    // 太字「bo」と斜字「lic」がそれぞれ独立に生き残る（両側のマーカーが保存された結果）
    assert.deepEqual(
      markdownModule.inlineSegments(rebuilt).map((s) => [s.kind, s.visibleText]),
      [["bold", "bo"], ["italic", "lic"]],
    );
  });

  test("置換（タイピング・ペースト）は削除範囲の位置＝装飾の中に挿入テキストが入る", () => {
    const result = deletionSurvivingFragment(BOLD_LINE, 4, 7);
    const line = BOLD_LINE.slice(0, 4)
      + result.text.slice(0, result.insertOffset) + "X" + result.text.slice(result.insertOffset)
      + BOLD_LINE.slice(7);
    assert.equal(line, "abc **Xold** def");
  });

  test("リンクも部分選択ではマーカー（[]・(url)）を保存する", () => {
    const link = "[hi](https://example.com)";
    // 可視「h」だけ削除
    const from = link.indexOf("hi");
    const result = deletionSurvivingFragment(link, from, from + 1);
    const rebuilt = link.slice(0, from) + result.text + link.slice(from + 1);
    assert.equal(rebuilt, "[i](https://example.com)");
  });

  test("選択なし（collapsed）は挿入テキストがそのまま入る", () => {
    assert.deepEqual(deletionSurvivingFragment(BOLD_LINE, 7, 7), { text: "", insertOffset: 0 });
  });

  test("インライン生表示（reveal）中はマーカー自体が直接削除の対象になる（保存しない）", () => {
    // "a**b**c" の可視末尾（"**b**" の直後）で Backspace すると、reveal 中は装飾全体
    // （マーカー込み）が可視 = raw 1:1 の生テキスト扱いになるため、閉じマーカーの 1 文字目
    // （raw [4,5)）がそのまま削除される（マーカー保存の対象にならない）
    const line = "a**b**c";
    const reveal = { start: 1, end: 6 };
    const result = deletionSurvivingFragment(line, 4, 5, undefined, reveal);
    assert.deepEqual(result, { text: "", insertOffset: 0 });
    const rebuilt = line.slice(0, 4) + result.text + line.slice(5);
    assert.equal(rebuilt, "a**b*c");
  });

  test("フェンス内容行は markerLen=0 を明示しないと、コードの文字を装飾記法として誤認する", () => {
    // フェンス内容行の raw は可視テキストそのまま（先頭の "* " も実コードの一部）。呼び出し元
    // （note.js）は lineStartColumn（フェンス内容行なら常に 0）を渡すこと。省略時の既定
    // markerLength は "* " をリストマーカーと誤認して markerLen=2 を返すため、markerLen 分だけ
    // 手前を切り落とした残り "*x*" を widenRangeForEmptiedDecorations が斜字装飾として解釈して
    // しまい、実際にはコードの一部でしかない "*" を含めてマーカーごと広げてしまう
    const fenceLine = "* *x*";
    const wrongWiden = widenRangeForEmptiedDecorations(fenceLine, 3, 4); // markerLen 省略（誤り）
    assert.deepEqual(wrongWiden, { lo: 2, hi: 5 }); // "*x*" ごと広がる（コードを装飾扱いした）

    const rightWiden = widenRangeForEmptiedDecorations(fenceLine, 3, 4, 0); // markerLen=0 を明示
    assert.deepEqual(rightWiden, { lo: 3, hi: 4 }); // 選択した "x" 一文字だけ（広がらない）

    const wrongResult = deletionSurvivingFragment(fenceLine, wrongWiden.lo, wrongWiden.hi, 2);
    const wrongRebuilt = fenceLine.slice(0, wrongWiden.lo) + wrongResult.text + fenceLine.slice(wrongWiden.hi);
    assert.equal(wrongRebuilt, "* "); // "*x*" ごと消えてしまう

    const rightResult = deletionSurvivingFragment(fenceLine, rightWiden.lo, rightWiden.hi, 0);
    const rightRebuilt = fenceLine.slice(0, rightWiden.lo) + rightResult.text + fenceLine.slice(rightWiden.hi);
    assert.equal(rightRebuilt, "* **"); // "x" だけが消える
  });
});

describe("widenRangeForEmptiedDecorations — 空マーカー正規化", () => {
  const line = "abc **x** def"; // 内容が 1 文字だけの太字。charMap は srcStart=6, len=1

  test("内容が丸ごと消える範囲 → マーカーごと含むよう広げる", () => {
    assert.deepEqual(widenRangeForEmptiedDecorations(line, 6, 7), { lo: 4, hi: 9 });
  });

  test("内容の一部だけが残る範囲 → 広げない（部分選択の保存に任せる）", () => {
    const multiChar = "abc **xy** def"; // 内容 "xy"（2 文字）のうち 1 文字だけ消える
    assert.deepEqual(widenRangeForEmptiedDecorations(multiChar, 6, 7), { lo: 6, hi: 7 });
  });

  test("既にマーカーごと覆っている範囲 → 変化しない（二重に広げない）", () => {
    assert.deepEqual(widenRangeForEmptiedDecorations(line, 4, 9), { lo: 4, hi: 9 });
  });

  test("リンクは対象外（ラベルが空でも URL が実体として残るため正規化しない）", () => {
    const link = "[hi](https://example.com)";
    const from = link.indexOf("hi");
    assert.deepEqual(
      widenRangeForEmptiedDecorations(link, from, from + 2),
      { lo: from, hi: from + 2 },
    );
  });

  test("装飾と重ならない範囲は変化しない", () => {
    assert.deepEqual(widenRangeForEmptiedDecorations(line, 0, 4), { lo: 0, hi: 4 });
  });

  test("widen 後に deletionSurvivingFragment を通すと raw にマーカーが残らない（undo 1 手の下地）", () => {
    const { lo, hi } = widenRangeForEmptiedDecorations(line, 6, 7);
    const result = deletionSurvivingFragment(line, lo, hi);
    const rebuilt = line.slice(0, lo) + result.text + line.slice(hi);
    assert.equal(rebuilt, "abc  def");
    assert.doesNotMatch(rebuilt, /\*/);
  });

  test("マーカー文字自体だけを含む範囲（内容には触れていない）は広げない", () => {
    // "abc **x** def" の閉じマーカー 1 文字目（raw [7, 8)）だけを対象にしても、
    // 内容 "x"（raw [6, 7)）はまだ残っているので正規化の対象にならない
    // （インライン生表示中にマーカー文字を直接削除する操作はこの形になる。widen は reveal を
    // 受け取らないが、内容に触れていない限り結果は変わらない。理由は関数コメント参照）
    assert.deepEqual(widenRangeForEmptiedDecorations(line, 7, 8), { lo: 7, hi: 8 });
  });
});

describe("widenRangeForEmptiedDecorations — 返り値は常に入力範囲を包含する", () => {
  // lo・hi が markerLen 未満（inline 座標へ変換すると負になる）のとき、負の座標をクランプすると
  // 「クランプで失われた分だけ返り値が入力より狭くなる」（widen のはずが縮む）。行頭マーカーを
  // 含む選択は resolveSelectionBounds の正規化で lo=0 や hi=0 になる（note.js 参照）ため、
  // マーカー付き行を含む行またぎ選択の削除・置換で常態的に踏む経路になる

  test("開始行が可視行頭（lo=0）から始まる範囲 → マーカーごと含めたまま広げる", () => {
    assert.deepEqual(widenRangeForEmptiedDecorations("- item", 0, 6, 2), { lo: 0, hi: 6 });
    assert.deepEqual(widenRangeForEmptiedDecorations("# head", 0, 6, 2), { lo: 0, hi: 6 });
    assert.deepEqual(widenRangeForEmptiedDecorations("> quote", 0, 7, 2), { lo: 0, hi: 7 });
  });

  test("終了行が可視行頭で終わる範囲（hi=0、内容は 1 文字も選んでいない） → 変化しない", () => {
    // hi=0 を markerLen 分だけクランプ後に markerLen へ戻すと hi=2 になり、選んでいない
    // マーカー（"- "）まで削除対象に含めてしまう（呼び出し元はこの結果をそのまま
    // lines[line].slice(0, hi) の hi に使うため、この行のマーカーが丸ごと消える）
    assert.deepEqual(widenRangeForEmptiedDecorations("- item", 0, 0, 2), { lo: 0, hi: 0 });
  });

  test("lo がマーカー内部でも、マーカーの外側にある装飾はそれと無関係に広がる", () => {
    // "> **x** y" の内容 "x" が丸ごと選択範囲に入っていれば、lo がマーカー内部（0 < markerLen）
    // でも装飾のマーカーごと広げる判定自体は独立して働く（ループが負の inline 座標下で死んで
    // いないことの確認）
    assert.deepEqual(widenRangeForEmptiedDecorations("> **x** y", 0, 5, 2), { lo: 0, hi: 7 });
  });
});

describe("isCheckboxLine", () => {
  test("未チェック → true", () => {
    assert.equal(isCheckboxLine("- [ ] task"), true);
  });

  test("チェック済み（大文字小文字とも） → true", () => {
    assert.equal(isCheckboxLine("- [x] task"), true);
    assert.equal(isCheckboxLine("- [X] task"), true);
  });

  test("* マーカーでも true", () => {
    assert.equal(isCheckboxLine("* [ ] task"), true);
  });

  test("インデント付きでも true", () => {
    assert.equal(isCheckboxLine("  - [ ] task"), true);
  });

  test("内容が空でも true（マーカーだけの行）", () => {
    assert.equal(isCheckboxLine("- [ ] "), true);
  });

  test("通常のリスト項目 → false", () => {
    assert.equal(isCheckboxLine("- item"), false);
  });

  test("通常のテキスト → false", () => {
    assert.equal(isCheckboxLine("[ ] task"), false);
  });
});
