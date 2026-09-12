const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

// rewriteImageWidth は rangeTouchesCodeSpan 経由で CODE_RE を参照する。note-lines.test.js と
// 同じ作法で、require 前にブラウザのグローバルスコープ相当を生やす
global.CODE_RE = require("../../src/markdown.js").CODE_RE;

const {
  isValidImageRelPath,
  rewriteImageWidth,
  stripFileExtension,
  formatDateForAlt,
  isGenericImageFileName,
  decideImageAlt,
  sanitizeAltText,
  sanitizeImageAlt,
  sanitizeUrl,
  isDataUri,
  MAX_IMAGE_BYTES,
  DATA_URI_TOO_LARGE,
  decodeDataUri,
  graphemesOf,
} = require("../../src/note-lines.js");

const UUID = "00000000-0000-4000-8000-000000000001";

describe("isValidImageRelPath", () => {
  test("正常な相対パス → true", () => {
    assert.equal(isValidImageRelPath(`images/${UUID}.png`), true);
  });

  test("拡張子違い（jpg/jpeg/gif/webp、大文字小文字）も true", () => {
    for (const ext of ["jpg", "jpeg", "gif", "webp", "PNG", "JPG"]) {
      assert.equal(isValidImageRelPath(`images/${UUID}.${ext}`), true, ext);
    }
  });

  test("`..` を含むパストラバーサル細工 → false", () => {
    assert.equal(isValidImageRelPath("images/../notes.json"), false);
  });

  test("絶対パス → false", () => {
    assert.equal(isValidImageRelPath(`/images/${UUID}.png`), false);
  });

  test("空文字 → false", () => {
    assert.equal(isValidImageRelPath(""), false);
  });

  test("URL → false（images/ 相対パスのみ対象）", () => {
    assert.equal(isValidImageRelPath(`https://example.com/images/${UUID}.png`), false);
  });

  test("uuid 形状が不正 → false", () => {
    assert.equal(isValidImageRelPath("images/not-a-uuid.png"), false);
  });

  test("対応外の拡張子 → false", () => {
    assert.equal(isValidImageRelPath(`images/${UUID}.svg`), false);
  });

  test("文字列以外 → false", () => {
    assert.equal(isValidImageRelPath(undefined), false);
    assert.equal(isValidImageRelPath(null), false);
  });
});

describe("rewriteImageWidth", () => {
  const PATH = `images/${UUID}.png`;

  test("幅指定を新たに追加する", () => {
    const line = `![alt](${PATH})`;
    assert.equal(rewriteImageWidth(line, PATH, 300, 0), `![alt|300](${PATH})`);
  });

  test("既存の幅指定を置き換える（古い指定は消える）", () => {
    const line = `![alt|200](${PATH})`;
    assert.equal(rewriteImageWidth(line, PATH, 400, 0), `![alt|400](${PATH})`);
  });

  test("1 行に複数画像がある場合、occurrence 番目だけを書き換える", () => {
    const other = "images/00000000-0000-4000-8000-000000000002.png";
    const line = `![a](${PATH}) ![b](${other}) ![c](${PATH})`;
    // relSrc が一致する画像のうち 1 番目（0始まり）＝2 個目の PATH 画像だけを書き換える
    assert.equal(
      rewriteImageWidth(line, PATH, 300, 1),
      `![a](${PATH}) ![b](${other}) ![c|300](${PATH})`,
    );
  });

  test("occurrence 0 は relSrc が一致する最初の画像だけを書き換える", () => {
    const line = `![a](${PATH}) ![b](${PATH})`;
    assert.equal(rewriteImageWidth(line, PATH, 300, 0), `![a|300](${PATH}) ![b](${PATH})`);
  });

  test("コードスパン内の画像記法は書き換えない", () => {
    const line = `\`![a](${PATH})\` ![b](${PATH})`;
    // コードスパン内の記法は occurrence の対象外なので、行内で relSrc が一致する
    // 画像記法として数えるのはコードスパン外の 1 個だけになる
    assert.equal(
      rewriteImageWidth(line, PATH, 300, 0),
      `\`![a](${PATH})\` ![b|300](${PATH})`,
    );
  });

  test("relSrc が一致しない画像は書き換えない", () => {
    const other = "images/00000000-0000-4000-8000-000000000002.png";
    const line = `![a](${other})`;
    assert.equal(rewriteImageWidth(line, PATH, 300, 0), line);
  });

  test("occurrence が範囲外なら書き換えない", () => {
    const line = `![a](${PATH})`;
    assert.equal(rewriteImageWidth(line, PATH, 300, 1), line);
  });
});

describe("stripFileExtension", () => {
  test("通常の拡張子を除く", () => {
    assert.equal(stripFileExtension("photo.png"), "photo");
  });

  test("多段拡張子は末尾の 1 つだけ除く", () => {
    assert.equal(stripFileExtension("archive.tar.gz"), "archive.tar");
  });

  test("拡張子が無い名前はそのまま", () => {
    assert.equal(stripFileExtension("IMG_1234"), "IMG_1234");
  });

  test("先頭ドットだけの名前（隠しファイル相当）はそのまま", () => {
    assert.equal(stripFileExtension(".png"), ".png");
  });

  test("空文字はそのまま", () => {
    assert.equal(stripFileExtension(""), "");
  });
});

describe("formatDateForAlt", () => {
  test("1 桁の月日時分秒をゼロ埋めする", () => {
    assert.equal(formatDateForAlt(new Date(2026, 0, 5, 3, 4, 9)), "2026-01-05 03-04-09");
  });

  test("2 桁の月日時分秒はそのまま（ゼロ埋め不要）", () => {
    assert.equal(formatDateForAlt(new Date(2026, 8, 11, 10, 23, 45)), "2026-09-11 10-23-45");
  });
});

describe("isGenericImageFileName", () => {
  test("大文字小文字を無視して image と一致 → true", () => {
    assert.equal(isGenericImageFileName("image"), true);
    assert.equal(isGenericImageFileName("IMAGE"), true);
    assert.equal(isGenericImageFileName("Image"), true);
  });

  test("image 以外 → false", () => {
    assert.equal(isGenericImageFileName("photo"), false);
    assert.equal(isGenericImageFileName(""), false);
  });
});

describe("decideImageAlt", () => {
  const NOW = new Date(2026, 8, 11, 10, 23, 45);

  test("通常のファイル名は拡張子を除いた名前を alt にする", () => {
    assert.equal(decideImageAlt("dropped.png", NOW), "dropped");
  });

  test("拡張子を除いた名前が空なら日時にフォールバックする", () => {
    assert.equal(decideImageAlt("", NOW), formatDateForAlt(NOW));
  });

  test("useGenericFallback を渡さない場合（ドロップ経路）は汎用名でもそのまま使う", () => {
    assert.equal(decideImageAlt("image.png", NOW), "image");
  });

  test("useGenericFallback が true を返す名前（ペースト経路の image.png）は日時にフォールバックする", () => {
    assert.equal(decideImageAlt("image.png", NOW, isGenericImageFileName), formatDateForAlt(NOW));
    assert.equal(decideImageAlt("IMAGE.PNG", NOW, isGenericImageFileName), formatDateForAlt(NOW));
  });

  test("`]` や `|` を含む名前は sanitizeImageAlt で除去される", () => {
    assert.equal(decideImageAlt("a]b|c.png", NOW), "abc");
  });

  test("無害化で空になる名前（`]`/`|`/`` ` `` のみ）は日時にフォールバックする", () => {
    assert.equal(decideImageAlt("].png", NOW), formatDateForAlt(NOW));
    assert.equal(decideImageAlt("|.png", NOW), formatDateForAlt(NOW));
    assert.equal(decideImageAlt("`.png", NOW), formatDateForAlt(NOW));
  });

  test("無害化後に汎用既定名と一致する名前（ペースト経路）も日時にフォールバックする", () => {
    assert.equal(decideImageAlt("image].png", NOW, isGenericImageFileName), formatDateForAlt(NOW));
  });
});

describe("sanitizeAltText", () => {
  test("改行は空白に置換する", () => {
    assert.equal(sanitizeAltText("a\nb"), "a b");
    assert.equal(sanitizeAltText("a\r\nb"), "a b");
    assert.equal(sanitizeAltText("a\rb"), "a b");
  });

  test("`]` は除去する（記法の終端と衝突するため）", () => {
    assert.equal(sanitizeAltText("a]b]c"), "abc");
  });

  test("`|` はそのまま残す（幅記法と無関係な用途向け）", () => {
    assert.equal(sanitizeAltText("a|b"), "a|b");
  });

  test("対象を含まない文字列はそのまま", () => {
    assert.equal(sanitizeAltText("plain"), "plain");
  });
});

describe("sanitizeImageAlt", () => {
  test("sanitizeAltText の無害化に加えて `|` も除去する", () => {
    assert.equal(sanitizeImageAlt("a|300]b\nc"), "a300b c");
  });

  test("`|` を含まない文字列は sanitizeAltText と同じ結果", () => {
    assert.equal(sanitizeImageAlt("a]b\nc"), sanitizeAltText("a]b\nc"));
  });

  test("`` ` `` も除去する（markdown.js のコードスパン復元が属性エスケープ後に走るため）", () => {
    assert.equal(sanitizeImageAlt("a`b`c"), "abc");
  });
});

describe("sanitizeUrl", () => {
  test("改行を除去する", () => {
    assert.equal(sanitizeUrl("https://example.com/\na"), "https://example.com/a");
    assert.equal(sanitizeUrl("a\r\nb\rc"), "abc");
  });

  test("改行を含まない URL はそのまま", () => {
    assert.equal(sanitizeUrl("https://example.com/a"), "https://example.com/a");
  });
});

describe("isDataUri", () => {
  test("data: スキーム → true（大文字小文字を無視）", () => {
    assert.equal(isDataUri("data:image/png;base64,abc"), true);
    assert.equal(isDataUri("DATA:image/png;base64,abc"), true);
  });

  test("data: 以外 → false", () => {
    assert.equal(isDataUri("https://example.com/a.png"), false);
    assert.equal(isDataUri("images/a.png"), false);
    assert.equal(isDataUri(""), false);
  });
});

describe("decodeDataUri", () => {
  test("正常な base64 データをデコードする", () => {
    const bytes = decodeDataUri("data:image/png;base64,aGVsbG8=");
    assert.deepEqual(Array.from(bytes), Array.from(Buffer.from("hello")));
  });

  test("charset 等の追加パラメータ・大文字小文字表記も許容する", () => {
    const bytes = decodeDataUri("DATA:image/png;charset=utf-8;BASE64,aGVsbG8=");
    assert.deepEqual(Array.from(bytes), Array.from(Buffer.from("hello")));
  });

  test("base64 形式でない（`,` が無い等）→ null", () => {
    assert.equal(decodeDataUri("data:image/png;base64"), null);
    assert.equal(decodeDataUri("not-a-data-uri"), null);
  });

  test("base64 として不正な文字列 → null（atob が例外を投げる）", () => {
    assert.equal(decodeDataUri("data:image/png;base64,not base64!!"), null);
  });

  // 概算は floor(base64 長 * 3 / 4)。閾値ちょうどと 1 文字超過の対で境界を固定する。
  // atob を呼ばずに文字数だけで判定するため、デコード可能な文字列でなくても閾値判定には掛かる
  test("概算サイズが MAX_IMAGE_BYTES ちょうどなら DATA_URI_TOO_LARGE にならない", () => {
    const len = Math.ceil((MAX_IMAGE_BYTES * 4) / 3);
    assert.equal(Math.floor((len * 3) / 4), MAX_IMAGE_BYTES);
    const result = decodeDataUri(`data:image/png;base64,${"A".repeat(len)}`);
    // 失敗時に 10 MB の配列の差分を作らせないよう、型と長さだけを見る
    assert.ok(result instanceof Uint8Array);
    assert.equal(result.length, MAX_IMAGE_BYTES);
  });

  test("概算サイズが MAX_IMAGE_BYTES を 1 バイトでも超えれば DATA_URI_TOO_LARGE", () => {
    const len = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 1;
    assert.equal(Math.floor((len * 3) / 4), MAX_IMAGE_BYTES + 1);
    assert.equal(decodeDataUri(`data:image/png;base64,${"A".repeat(len)}`), DATA_URI_TOO_LARGE);
  });

  test("閾値未満のサイズは通常どおりデコードを試みる", () => {
    const base64 = Buffer.alloc(1024, "A").toString("base64");
    const result = decodeDataUri(`data:image/png;base64,${base64}`);
    assert.notEqual(result, DATA_URI_TOO_LARGE);
    assert.ok(result instanceof Uint8Array);
  });
});

describe("graphemesOf", () => {
  test("ASCII はそのまま 1 文字ずつ", () => {
    assert.deepEqual(graphemesOf("abc"), ["a", "b", "c"]);
  });

  test("空文字は空配列", () => {
    assert.deepEqual(graphemesOf(""), []);
  });

  test("サロゲートペア（絵文字単体）は 1 書記素として数える", () => {
    assert.deepEqual(graphemesOf("😀"), ["😀"]);
  });

  test("ZWJ で結合された絵文字列は 1 書記素として数える", () => {
    // 👨‍👩‍👧 = 👨 + ZWJ + 👩 + ZWJ + 👧
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    assert.deepEqual(graphemesOf(family), [family]);
  });

  test("肌色修飾子付き絵文字も 1 書記素として数える", () => {
    const wave = "\u{1F44B}\u{1F3FB}"; // 👋🏻
    assert.deepEqual(graphemesOf(wave), [wave]);
  });

  test("複数の書記素が混在する文字列を正しく分割する", () => {
    const s = `a${"\u{1F468}‍\u{1F469}‍\u{1F467}"}b😀`;
    assert.deepEqual(graphemesOf(s), ["a", "\u{1F468}‍\u{1F469}‍\u{1F467}", "b", "😀"]);
  });
});
