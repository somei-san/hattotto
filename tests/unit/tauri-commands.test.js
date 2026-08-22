// Tauri コマンド名の照合テスト。バックエンドの登録一覧を正として、
// テスト用モックとフロントエンドの呼び出しに、実在しないコマンド名が
// 紛れ込んでいないかを検出する。モックの default 節が null を返すため、
// 名前の食い違いはテストの失敗としては現れない。
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

/** `generate_handler![...]` に登録されたコマンド名。 */
function handlerCommands() {
  const src = read("src-tauri/src/lib.rs");
  const block = src.match(/generate_handler!\[([\s\S]*?)\]/);
  assert.ok(block, "generate_handler! が lib.rs に見つからない");
  return [...block[1].matchAll(/commands::(\w+)/g)].map((m) => m[1]);
}

/** fixtures.ts のモックの switch が分岐するコマンド名。plugin 呼び出しは対象外。 */
function mockCommands() {
  const src = read("tests/visual/fixtures.ts");
  return [...src.matchAll(/case "([^"]+)":/g)]
    .map((m) => m[1])
    .filter((c) => !c.startsWith("plugin:"));
}

/** src/*.js が invoke / fireInvoke に渡すコマンド名リテラル。plugin 呼び出しは対象外。 */
function invokedCommands() {
  const names = new Set();
  for (const f of fs.readdirSync(path.join(root, "src"))) {
    if (!f.endsWith(".js")) continue;
    const src = read(path.join("src", f));
    for (const m of src.matchAll(/(?:invoke|fireInvoke)\(\s*['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith("plugin:")) names.add(m[1]);
    }
  }
  return [...names];
}

describe("Tauri コマンド名の照合", () => {
  const handlers = handlerCommands();

  test("抽出の空振り検知: 登録一覧が取れている", () => {
    assert.ok(handlers.includes("get_note"));
    assert.ok(handlers.length >= 10, `抽出できたのは ${handlers.length} 件だけ`);
  });

  test("モックの分岐は実在するコマンドだけを持つ", () => {
    const unknown = mockCommands().filter((c) => !handlers.includes(c));
    assert.deepEqual(unknown, [], `generate_handler! に無いコマンド: ${unknown}`);
  });

  test("フロントエンドが呼ぶコマンドはすべて実在する", () => {
    const unknown = invokedCommands().filter((c) => !handlers.includes(c));
    assert.deepEqual(unknown, [], `generate_handler! に無いコマンド: ${unknown}`);
  });
});
