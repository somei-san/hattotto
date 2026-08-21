const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const I18N = require("../../src/i18n.js");

describe("I18N.resolve", () => {
  test("'ja' / 'en' はそのまま解決される", () => {
    assert.equal(I18N.resolve("ja"), "ja");
    assert.equal(I18N.resolve("en"), "en");
  });
});
