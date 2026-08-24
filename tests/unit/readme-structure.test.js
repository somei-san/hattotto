const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// 日英 README は同じ構成の対訳として管理している。片方だけの編集は
// 人が読み比べないと気づけないため、機械で照合できる範囲（見出しの階層と
// 箇条書きの本数）だけでもテストでズレを検出する。

function readReadme(name) {
  return fs.readFileSync(path.join(__dirname, "../..", name), "utf8");
}

/** コードブロックを除いた行の配列を返す（``` 内の # や - を見出し・箇条書きと誤認しないため） */
function proseLines(markdown) {
  const lines = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) lines.push(line);
  }
  return lines;
}

/** 見出し行を「レベル数字の並び」にする（例: [2, 2, 3, 2]） */
function headingLevels(markdown) {
  return proseLines(markdown)
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => line.match(/^#+/)[0].length);
}

/** トップレベル箇条書きの本数を、直前の見出しごとに数える */
function bulletCountsBySection(markdown) {
  const counts = [];
  let current = null;
  for (const line of proseLines(markdown)) {
    if (/^#{1,6} /.test(line)) {
      current = { heading: line, bullets: 0 };
      counts.push(current);
    } else if (current && /^- /.test(line)) {
      current.bullets += 1;
    }
  }
  return counts;
}

describe("日英 README の構成", () => {
  const en = readReadme("README.md");
  const ja = readReadme("README.ja.md");

  test("見出しの個数と階層の並びが一致する", () => {
    assert.deepEqual(headingLevels(en), headingLevels(ja));
  });

  test("セクションごとのトップレベル箇条書きの本数が一致する", () => {
    const enCounts = bulletCountsBySection(en);
    const jaCounts = bulletCountsBySection(ja);
    assert.equal(enCounts.length, jaCounts.length);
    for (let i = 0; i < enCounts.length; i++) {
      assert.equal(
        enCounts[i].bullets,
        jaCounts[i].bullets,
        `セクションの箇条書きの本数が一致しません: "${enCounts[i].heading}" (${enCounts[i].bullets}) / "${jaCounts[i].heading}" (${jaCounts[i].bullets})`,
      );
    }
  });
});
