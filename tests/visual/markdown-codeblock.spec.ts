import { test, expect } from "./fixtures";

async function render(page: any, text: string): Promise<string> {
  return page.evaluate((t: string) => (window as any).renderMarkdown(t), text);
}

test.describe("renderMarkdown — fenced code block", () => {
  test("basic code block", async ({ notePage }) => {
    const html = await render(notePage, "```\nconst x = 1;\n```");
    expect(html).toContain('<pre class="md-codeblock"><code>const x = 1;</code></pre>');
  });

  test("code block with language specifier", async ({ notePage }) => {
    const html = await render(notePage, "```js\nlet y = 2;\n```");
    expect(html).toContain('<pre class="md-codeblock"><code>let y = 2;</code></pre>');
  });

  test("markdown inside code block is not parsed", async ({ notePage }) => {
    const html = await render(notePage, "```\n# not a heading\n**not bold**\n- not a list\n```");
    expect(html).toContain('<pre class="md-codeblock"><code>');
    expect(html).not.toContain('md-h1');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('md-bullet');
  });

  test("HTML is escaped inside code block", async ({ notePage }) => {
    const html = await render(notePage, "```\n<div>test</div>\n```");
    expect(html).toContain('&lt;div&gt;test&lt;/div&gt;');
  });

  test("multiple code blocks", async ({ notePage }) => {
    const html = await render(notePage, "text\n```\nblock1\n```\nmiddle\n```\nblock2\n```");
    const matches = html.match(/md-codeblock/g);
    expect(matches).toHaveLength(2);
    expect(html).toContain('block1');
    expect(html).toContain('block2');
    expect(html).toContain('md-line');
  });

  test("unclosed code block still renders", async ({ notePage }) => {
    const html = await render(notePage, "```\nunclosed code");
    expect(html).toContain('<pre class="md-codeblock"><code>unclosed code</code></pre>');
  });

  test("empty code block", async ({ notePage }) => {
    const html = await render(notePage, "```\n```");
    expect(html).toContain('<pre class="md-codeblock"><code></code></pre>');
  });

  test("code block preserves multiple lines", async ({ notePage }) => {
    const html = await render(notePage, "```\nline1\nline2\nline3\n```");
    expect(html).toContain('line1\nline2\nline3');
  });

  test("normal markdown before and after code block", async ({ notePage }) => {
    const html = await render(notePage, "# Title\n```\ncode\n```\n- item");
    expect(html).toContain('md-h1');
    expect(html).toContain('md-codeblock');
    expect(html).toContain('md-bullet');
  });
});
