import { test, expect } from "./fixtures";

// ── Unit tests: CHECKBOX_RE pattern matching ────────────────

function matchCheckbox(page: any, text: string) {
  return page.evaluate((t: string) => {
    const m = t.match((window as any).CHECKBOX_RE);
    return m ? [m[1], m[2]] : null;
  }, text);
}

test.describe("CHECKBOX_RE pattern", () => {
  test("- [] matches", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "- []")).toEqual(["-", ""]);
  });

  test("- [x] matches", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "- [x]")).toEqual(["-", "x"]);
  });

  test("- [X] matches", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "- [X]")).toEqual(["-", "X"]);
  });

  test("- [ ] does not match (already correct format)", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "- [ ]")).toBeNull();
  });

  test("* [] matches", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "* []")).toEqual(["*", ""]);
  });

  test("* [x] matches", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "* [x]")).toEqual(["*", "x"]);
  });

  test("* [X] matches", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "* [X]")).toEqual(["*", "X"]);
  });

  test("-[] (no space) matches", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "-[]")).toEqual(["-", ""]);
  });

  test("-[x] (no space) matches", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "-[x]")).toEqual(["-", "x"]);
  });

  test("*[] (no space) matches", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "*[]")).toEqual(["*", ""]);
  });

  test("*[x] (no space) matches", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "*[x]")).toEqual(["*", "x"]);
  });

  test("already correct '- [ ] ' does not match (trailing space+text)", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "- [ ] ")).toBeNull();
  });

  test("plain text does not match", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "hello")).toBeNull();
  });

  test("no bullet does not match", async ({ notePage }) => {
    expect(await matchCheckbox(notePage, "[]")).toBeNull();
  });
});

// ── E2E tests: typing triggers autocomplete ─────────────────

async function enterEditMode(page: import("@playwright/test").Page) {
  await page.click("#markdown-view");
  await page.waitForSelector(".editor", { state: "visible" });
}

test.describe("checkbox autocomplete E2E", () => {
  test("typing '- []' autocompletes to '- [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("- []", { delay: 30 });
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toBe("- [ ] ");
  });

  test("typing '- [x]' autocompletes to '- [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("- [x]", { delay: 30 });
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toBe("- [x] ");
  });

  test("typing '- [X]' autocompletes to '- [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("- [X]", { delay: 30 });
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toBe("- [x] ");
  });

  test("typing '* []' autocompletes to '* [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("* []", { delay: 30 });
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toBe("* [ ] ");
  });

  test("typing '-[]' autocompletes to '- [ ] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("-[]", { delay: 30 });
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toBe("- [ ] ");
  });

  test("typing '*[x]' autocompletes to '* [x] '", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("*[x]", { delay: 30 });
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toBe("* [x] ");
  });

  test("cursor is placed after autocomplete", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("- []", { delay: 30 });
    await page.keyboard.type("task", { delay: 30 });
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toBe("- [ ] task");
  });

  test("does not autocomplete on second line without checkbox", async ({ openNote }) => {
    const page = await openNote();
    await enterEditMode(page);
    await page.keyboard.type("hello", { delay: 30 });
    const text = await page.$eval(".editor", (el) => (el as HTMLElement).innerText);
    expect(text).toBe("hello");
  });
});
