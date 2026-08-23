const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const I18N = require("../../src/i18n.js");

describe("I18N.resolve", () => {
  test("'ja' / 'en' はそのまま解決される（systemLanguage を無視する）", () => {
    assert.equal(I18N.resolve("ja", "en"), "ja");
    assert.equal(I18N.resolve("en", "ja"), "en");
  });

  test("'auto' / undefined は systemLanguage に従う", () => {
    assert.equal(I18N.resolve("auto", "ja"), "ja");
    assert.equal(I18N.resolve("auto", "en"), "en");
    assert.equal(I18N.resolve(undefined, "ja"), "ja");
    assert.equal(I18N.resolve(undefined, "en"), "en");
  });
});
