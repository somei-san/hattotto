import { test, expect, enterEdit, getContent } from "./fixtures";

// 生エディタ（contenteditable）は独立した編集可能領域のため、WebKit/Chromium は選択を
// その境界でクランプする。境界に達したとき（＝ネイティブがこれ以上選択を伸ばせなかったとき）に
// エディタを commit で閉じ、描画 DOM 上の選択へ変換することで、キャレット行を起点にした
// 行またぎ選択（Shift+矢印・マウスドラッグ）を成立させる。
// 変換後は Cross-line Selection Guard・削除系・コピー系が既存のまま効く。

/** ed の最初のテキストノードの offset へキャレットを置く（合成 IME を経由しない直接操作）。 */
function placeEditorCaret(page: import("@playwright/test").Page, offset: number) {
  return page.evaluate((o) => {
    const ed = document.getElementById("editor")!;
    const range = document.createRange();
    range.setStart(ed.firstChild!, o);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }, offset);
}

function selectionText(page: import("@playwright/test").Page) {
  return page.evaluate(() => window.getSelection()!.toString());
}

function hasEditor(page: import("@playwright/test").Page) {
  return page.evaluate(() => !!document.getElementById("editor"));
}

test.describe("Shift+ArrowDown/Up でエディタ境界を越える", () => {
  test("Shift+ArrowDown: 行末から次の描画行へ越え、行またぎ選択になる", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghijkl" });
    await enterEdit(page, 1); // "def"
    await placeEditorCaret(page, 3); // "def" の行末（これ以上エディタ内では伸ばせない）

    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(50);

    expect(await hasEditor(page)).toBe(false);
    expect(await selectionText(page)).toBe("\nghi"); // anchor=def行末、focus=同じ可視列(3)
  });

  test("Shift+ArrowUp: 行頭から前の描画行へ越え、行またぎ選択になる", async ({ openNote }) => {
    const page = await openNote({ content: "abcdef\nghi\njkl" });
    await enterEdit(page, 1); // "ghi"
    await placeEditorCaret(page, 0); // "ghi" の行頭

    await page.keyboard.press("Shift+ArrowUp");
    await page.waitForTimeout(50);

    expect(await hasEditor(page)).toBe(false);
    expect(await selectionText(page)).toBe("abcdef\n"); // anchor=ghi行頭、focus=前行の同じ可視列（0）＝行頭
  });

  test("マーカー付き行が越えた先でも、可視列（マーカーを除いた列）で位置合わせされる", async ({ openNote }) => {
    const page = await openNote({ content: "abc\n- item" });
    await enterEdit(page, 0); // "abc"
    await placeEditorCaret(page, 3); // "abc" の行末（可視列 3）

    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(50);

    // "- item" の可視列 3 は "- " マーカーを除いた "ite" の直後
    expect(await selectionText(page)).toBe("\nite");
  });

  test("次の描画行が無い（最終行）ときは変換せず、生エディタのまま何もしない", async ({ openNote }) => {
    // 越え先が無いのに commitActive() してしまうと、生エディタが閉じてフォーカスされた
    // contenteditable が無くなり、直後の文字入力が黙って捨てられる（←→ 側は元々この判定を
    // commit より前に行っており、↑↓ 側もそれに揃える）
    const page = await openNote({ content: "abc\ndef" });
    await enterEdit(page, 1); // "def"（最終行）
    await placeEditorCaret(page, 1);

    await page.keyboard.press("Shift+ArrowDown"); // 1回目: 行末まではネイティブで伸びる
    await page.waitForTimeout(50);
    expect(await hasEditor(page)).toBe(true);
    expect(await selectionText(page)).toBe("ef");

    await page.keyboard.press("Shift+ArrowDown"); // 2回目: 越える先が無いので変換せず何もしない
    await page.waitForTimeout(50);
    expect(await hasEditor(page)).toBe(true);
    expect(await selectionText(page)).toBe("ef"); // 選択は変わらない
    expect(await getContent(page)).toBe("abc\ndef"); // 内容は変わらない

    // 生エディタが閉じていなければ、直後の入力はそのまま上書きされる（黙って捨てられない）
    await page.keyboard.press("x");
    expect(await getContent(page)).toBe("abc\ndx");
  });

  test("次/前行がコードブロックのときは変換せず、生エディタのまま何もしない（↑↓）", async ({ openNote }) => {
    const page = await openNote({ content: "abc\n```\ncode\n```" });
    await enterEdit(page, 0); // "abc"
    await placeEditorCaret(page, 3); // 行末

    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(50);

    expect(await hasEditor(page)).toBe(true);
    expect(await selectionText(page)).toBe("");
    expect(await getContent(page)).toBe("abc\n```\ncode\n```");

    // 生エディタが閉じていなければ、直後の入力はそのまま上書きされる（黙って捨てられない）
    await page.keyboard.press("x");
    expect(await getContent(page)).toBe("abcx\n```\ncode\n```");
  });

  test("境界に達しない Shift+矢印は従来どおりネイティブのまま（生エディタは維持）", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndefghi\njkl" });
    await enterEdit(page, 1); // "defghi"
    await placeEditorCaret(page, 1);

    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(50);

    expect(await hasEditor(page)).toBe(true);
    expect(await selectionText(page)).toBe("efghi");
  });

  test("越えた後の Shift+ArrowDown でさらに選択が拡張される", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi\njkl" });
    await enterEdit(page, 1); // "def"
    await placeEditorCaret(page, 3);

    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(50);
    expect(await selectionText(page)).toBe("\nghi");

    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(50);
    expect(await selectionText(page)).toBe("\nghi\njkl");
  });

  test("越えた後の Shift+ArrowUp で選択が縮小し、単一行内に戻っても DOM 選択のまま", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });
    await enterEdit(page, 1); // "def"
    await placeEditorCaret(page, 3);

    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(50);
    expect(await selectionText(page)).toBe("\nghi");

    await page.keyboard.press("Shift+ArrowUp");
    await page.waitForTimeout(50);
    expect(await hasEditor(page)).toBe(false); // 生エディタには戻らない
  });
});

test.describe("越えた行またぎ選択に既存機構が接続する", () => {
  test("Backspace で越えた範囲が削除される", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghijkl" });
    await enterEdit(page, 1); // "def"
    await placeEditorCaret(page, 1);

    await page.keyboard.press("Shift+ArrowDown"); // 行末まで拡張（ネイティブ）
    await page.waitForTimeout(50);
    await page.keyboard.press("Shift+ArrowDown"); // 境界を越えて次行へ（変換）
    await page.waitForTimeout(50);
    expect(await selectionText(page)).toBe("ef\nghi");

    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("abc\ndjkl");
  });

  test("⌘X で越えた範囲がカットされる", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghijkl" });
    await enterEdit(page, 1); // "def"
    await placeEditorCaret(page, 3); // 行末（即座に越える）

    await page.keyboard.press("Shift+ArrowDown");
    await page.waitForTimeout(50);
    expect(await selectionText(page)).toBe("\nghi");

    await page.keyboard.press("ControlOrMeta+x");

    expect(await getContent(page)).toBe("abc\ndefjkl");
  });
});

test.describe("マウスドラッグでエディタ境界を越える", () => {
  test("生エディタ内で mousedown → 別行の上へドラッグ → mouseup で行またぎ選択になる", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });
    await enterEdit(page, 1); // "def"
    const edBox = await page.locator("#editor").boundingBox();
    const otherBox = await page.locator('#markdown-view [data-line="2"]').boundingBox(); // "ghi"
    if (!edBox || !otherBox) throw new Error("bounding box not found");

    await page.mouse.move(edBox.x + 5, edBox.y + edBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(otherBox.x + 5, otherBox.y + otherBox.height / 2, { steps: 5 });
    await page.mouse.up();

    expect(await hasEditor(page)).toBe(false);
    const result = await page.evaluate(() => {
      const sel = window.getSelection()!;
      return { collapsed: sel.isCollapsed, str: sel.toString() };
    });
    expect(result.collapsed).toBe(false);
    expect(result.str).toBe("def\ng");
  });

  test("同一行内のドラッグは変換されず、生エディタのまま", async ({ openNote }) => {
    const page = await openNote({ content: "abcdef\nghi" });
    await enterEdit(page, 0);
    const edBox = await page.locator("#editor").boundingBox();
    if (!edBox) throw new Error("bounding box not found");

    await page.mouse.move(edBox.x + 2, edBox.y + edBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(edBox.x + edBox.width - 2, edBox.y + edBox.height / 2, { steps: 5 });
    await page.mouse.up();

    expect(await hasEditor(page)).toBe(true);
  });

  test("ドラッグで越えた選択に Backspace が正しい範囲で効く", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });
    await enterEdit(page, 1); // "def"
    const edBox = await page.locator("#editor").boundingBox();
    const otherBox = await page.locator('#markdown-view [data-line="2"]').boundingBox(); // "ghi"
    if (!edBox || !otherBox) throw new Error("bounding box not found");

    await page.mouse.move(edBox.x + 5, edBox.y + edBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(otherBox.x + 5, otherBox.y + otherBox.height / 2, { steps: 5 });
    await page.mouse.up();
    const selected = await selectionText(page);

    await page.keyboard.press("Backspace");

    const content = await getContent(page);
    // ドラッグ終端の正確な列は環境のフォントメトリクスに依存するため、選択されたテキスト分
    // だけ短くなっていることで範囲の対応を確認する
    expect(content.length).toBe("abc\ndef\nghi".length - selected.length);
  });
});

test.describe("Shift+ArrowRight/Left でエディタ境界を越える", () => {
  test("Shift+ArrowRight: 行末から次の描画行の可視先頭へ越え、行またぎ選択になる", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });
    await enterEdit(page, 1); // "def"
    await placeEditorCaret(page, 3); // "def" の行末（これ以上エディタ内では伸ばせない）

    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(50);

    expect(await hasEditor(page)).toBe(false);
    expect(await selectionText(page)).toBe("\n"); // anchor=def行末、focus=ghi行頭（改行1文字分だけ）
  });

  test("Shift+ArrowLeft: 行頭から前の描画行の可視末尾へ越え、行またぎ選択になる", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });
    await enterEdit(page, 1); // "def"
    await placeEditorCaret(page, 0); // "def" の行頭

    await page.keyboard.press("Shift+ArrowLeft");
    await page.waitForTimeout(50);

    expect(await hasEditor(page)).toBe(false);
    expect(await selectionText(page)).toBe("\n"); // anchor=def行頭、focus=abc行末（改行1文字分だけ）
  });

  test("マーカー付き行が越えた先でも、可視先頭（マーカーの直後）に着地する", async ({ openNote }) => {
    const page = await openNote({ content: "abc\n- item" });
    await enterEdit(page, 0); // "abc"
    await placeEditorCaret(page, 3); // 行末

    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(50);

    // "- item" の可視先頭（"- " マーカーの直後）に着地するので、選択は改行 1 文字分だけ
    expect(await selectionText(page)).toBe("\n");
  });

  test("末尾/先頭に達していない Shift+ArrowRight/Left は従来どおりネイティブのまま", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });
    await enterEdit(page, 1); // "def"
    await placeEditorCaret(page, 1);

    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(50);

    expect(await hasEditor(page)).toBe(true);
    expect(await selectionText(page)).toBe("e");
  });

  test("最終行末尾の Shift+ArrowRight は何も起きない（次の描画行が無い）", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });
    await enterEdit(page, 1); // "def"（最終行）
    await placeEditorCaret(page, 3); // 行末

    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(50);

    expect(await hasEditor(page)).toBe(true);
    expect(await selectionText(page)).toBe("");
    expect(await getContent(page)).toBe("abc\ndef");
  });

  test("先頭行先頭の Shift+ArrowLeft は何も起きない（前の描画行が無い）", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef" });
    await enterEdit(page, 0); // "abc"（先頭行）
    await placeEditorCaret(page, 0); // 行頭

    await page.keyboard.press("Shift+ArrowLeft");
    await page.waitForTimeout(50);

    expect(await hasEditor(page)).toBe(true);
    expect(await selectionText(page)).toBe("");
    expect(await getContent(page)).toBe("abc\ndef");
  });

  test("越えた行またぎ選択に Backspace が正しい範囲で効く", async ({ openNote }) => {
    const page = await openNote({ content: "abc\ndef\nghi" });
    await enterEdit(page, 1); // "def"
    await placeEditorCaret(page, 3); // 行末

    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(50);
    expect(await selectionText(page)).toBe("\n");

    await page.keyboard.press("Backspace");

    expect(await getContent(page)).toBe("abc\ndefghi");
  });

  test("次/前行がコードブロックのときは対応スコープ外として何もしない（↑↓ と同じ判断）", async ({ openNote }) => {
    const page = await openNote({ content: "abc\n```\ncode\n```" });
    await enterEdit(page, 0); // "abc"
    await placeEditorCaret(page, 3); // 行末

    await page.keyboard.press("Shift+ArrowRight");
    await page.waitForTimeout(50);

    expect(await hasEditor(page)).toBe(true);
    expect(await selectionText(page)).toBe("");
    expect(await getContent(page)).toBe("abc\n```\ncode\n```");
  });

  // setTimeout(0) でのクランプ判定待ちの間に後続のキー入力が割り込むと、その入力が選択を
  // 偶然「境界越え前の anchor/focus」と同じ位置へ戻すことがある（Shift+→ で 1 文字だけ拡張した
  // 直後に無修飾 ← で畳むと、畳んだ結果が拡張前の位置に一致する）。この場合に誤って
  // 「クランプされた」と判定して変換してしまわないことを確認する（editorKeySeq のガード）
  test("clamp 判定待ちの間に後続キーが割り込んでも誤変換しない", async ({ openNote }) => {
    // page.keyboard.press を 2 連発しただけでは、CDP の往復レイテンシの間に 1 発目の
    // setTimeout(0) が 2 発目の到着より先に処理系側で drain してしまい、割り込みが
    // 実際には起きない（1 発目の判定は素の moved=true で素通りするだけになり、
    // editorKeySeq のガード経路を検証できない）。ここでは 1 回の page.evaluate 内で
    // keydown を発火 → その場でネイティブの選択拡張を模倣 → 続けて次の keydown を発火 →
    // ネイティブの「選択を畳む」を模倣、と同一マクロタスク内で組み立てることで、
    // 2 つの setTimeout(0) がまだ pending なうちに「拡張前と同じ位置に戻る」状況を
    // 確実に再現する（合成 KeyboardEvent はネイティブの既定動作を伴わないため、
    // 各 keydown 直後の選択操作でネイティブ相当の結果を手動で作る）。
    const page = await openNote({ content: "abc\ndef\nghi" });
    await enterEdit(page, 1); // "def"
    await placeEditorCaret(page, 0); // 行頭（collapsed）

    await page.evaluate(() => {
      const ed = document.getElementById("editor")!;
      const sel = window.getSelection()!;

      // 1) Shift+ArrowRight 相当。listener が snapshot（collapsed, col0）を捕まえ、
      //    setTimeout(0) をスケジュールする
      ed.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
      // ネイティブの「1 文字ぶん選択を伸ばす」を模倣（境界には達しない想定）
      const extended = document.createRange();
      extended.setStart(ed.firstChild!, 0);
      extended.setEnd(ed.firstChild!, 1);
      sel.removeAllRanges();
      sel.addRange(extended);

      // 2) 同一マクロタスク内で続けて無修飾 ArrowLeft 相当を発火
      ed.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
      // ネイティブの「選択を左端へ畳む」を模倣 → 1) の直前と同じ col0（collapsed）に戻る
      const collapsed = document.createRange();
      collapsed.setStart(ed.firstChild!, 0);
      collapsed.collapse(true);
      sel.removeAllRanges();
      sel.addRange(collapsed);
    });
    await page.waitForTimeout(50); // 2 つの setTimeout(0) が drain するのを待つ

    expect(await hasEditor(page)).toBe(true);
    expect(await page.evaluate(() => window.getSelection()!.isCollapsed)).toBe(true);
    expect(await getContent(page)).toBe("abc\ndef\nghi");
  });
});
