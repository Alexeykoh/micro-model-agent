import { describe, it, expect } from "vitest";
import { formatMarkdown, FormattingStream } from "../src/ui/md-formatter";

describe("formatMarkdown", () => {
  it("should format headings", () => {
    const result = formatMarkdown("# Title\n## Subtitle");
    expect(result).toContain("Title");
    expect(result).toContain("Subtitle");
  });

  it("should format code blocks", () => {
    const result = formatMarkdown("```ts\nconst x = 1\n```");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe("```ts\nconst x = 1\n```");
  });

  it("should format inline code", () => {
    const result = formatMarkdown("Use `const` keyword");
    expect(result).toContain("const");
  });

  it("should format bold text", () => {
    const result = formatMarkdown("**bold** text");
    expect(result).toContain("bold");
    expect(result).toContain("text");
  });

  it("should format lists", () => {
    const result = formatMarkdown("- item 1\n- item 2");
    expect(result).toContain("item 1");
    expect(result).toContain("item 2");
  });

  it("should format ordered lists", () => {
    const result = formatMarkdown("1. first\n2. second");
    expect(result).toContain("first");
    expect(result).toContain("second");
  });

  it("should format tables with aligned columns", () => {
    const md = "| Name | Value |\n|---|---|\n| alpha | 42 |";
    const result = formatMarkdown(md);
    expect(result).toContain("alpha");
    expect(result).toContain("┌");
    expect(result).toContain("│");
  });

  it("should format blockquotes", () => {
    const result = formatMarkdown("> quoted text");
    expect(result).toContain("quoted text");
  });

  it("should format checkboxes", () => {
    const done = formatMarkdown("- [x] finished");
    const todo = formatMarkdown("- [ ] pending");
    expect(done).toContain("finished");
    expect(todo).toContain("pending");
  });

  it("should format horizontal rules", () => {
    const result = formatMarkdown("text\n---\ntext2");
    expect(result).toContain("text");
    expect(result).toContain("text2");
    expect(result).not.toContain("---");
  });

  it("should format italic text", () => {
    const result = formatMarkdown("*emphasized* word");
    expect(result).toContain("emphasized");
  });

  it("should format links", () => {
    const result = formatMarkdown("[docs](https://example.com)");
    expect(result).toContain("docs");
    expect(result).toContain("example.com");
  });

  it("should not double-wrap inline code that contains markdown", () => {
    const result = formatMarkdown("Use `**x**` here");
    expect(result).toContain("**x**");
  });
});

function makeStream(): { chunks: string[]; stream: FormattingStream } {
  const chunks: string[] = [];
  const stream = new FormattingStream(
    (line) => chunks.push(line + "\n"),
    60,
    (text) => chunks.push(text),
  );
  return { chunks, stream };
}

describe("FormattingStream.flushPartialNow", () => {
  it("finalizes a displayed raw partial without duplication or rewinding", () => {
    const { chunks, stream } = makeStream();
    stream.write("partial");
    expect(stream.hasPartial()).toBe(true);
    stream.flushPartialNow();
    expect(stream.hasPartial()).toBe(false);
    stream.write("next line\n");
    stream.flush();
    const out = chunks.join("");
    expect(out).toContain("partial");
    expect(out).toContain("next line");
    expect(out.indexOf("next line")).toBeGreaterThan(out.indexOf("partial"));
    expect(out).toContain("partial\nnext line\n");
    expect(out).not.toContain("\x1b[7D");
  });

  it("is idempotent and emits only one trailing newline", () => {
    const { chunks, stream } = makeStream();
    stream.write("partial");
    stream.flushPartialNow();
    stream.flushPartialNow();
    expect(chunks.join("")).toBe("partial\n");
  });

  it("keeps an open code block open so following prose is not swallowed", () => {
    const { chunks, stream } = makeStream();
    stream.write("```ts\nconst x = 1");
    stream.flushPartialNow();
    expect(chunks.join("")).toBe("");
    stream.write("\n```\nprose after\n");
    stream.flush();
    const out = chunks.join("");
    const boxStart = out.indexOf("┌");
    const boxEnd = out.lastIndexOf("┘");
    expect(boxStart).toBeGreaterThanOrEqual(0);
    const codeBox = out.slice(boxStart, boxEnd + 1);
    expect(codeBox).toContain("const x = 1");
    expect(codeBox).not.toContain("prose after");
    expect(out.indexOf("prose after")).toBeGreaterThan(boxEnd);
  });

  it("flushes a pending table buffer", () => {
    const { chunks, stream } = makeStream();
    stream.write("| Name | Value |\n|---|---|\n");
    stream.flushPartialNow();
    const out = chunks.join("");
    expect(out).toContain("┌");
    expect(out).toContain("Name");
    expect(out).toContain("Value");
  });
});
