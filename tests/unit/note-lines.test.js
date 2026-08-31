const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

// visibleOffsetToRawOffset は inlineSegments をブラウザのグローバルスコープ経由で参照する
// （note.html の読み込み順で markdown.js → note-lines.js の順に読まれるのを前提にしている）。
// markdown-codeblock.test.js の escapeHtml と同じ作法で、require 前に global へ生やす
global.inlineSegments = require("../../src/markdown.js").inlineSegments;

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
