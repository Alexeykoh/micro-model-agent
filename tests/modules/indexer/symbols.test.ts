import { describe, it, expect } from "vitest";
import {
  extractSymbols,
  isCodeLanguage,
  languageIdForExt,
  MAX_SYMBOLS_PER_FILE,
} from "../../../src/modules/indexer/symbols";

describe("languageIdForExt", () => {
  it("maps extensions to language ids", () => {
    expect(languageIdForExt(".ts")).toBe("typescript");
    expect(languageIdForExt(".py")).toBe("python");
    expect(languageIdForExt(".GO")).toBe("go");
    expect(languageIdForExt(".unknown")).toBeNull();
  });

  it("flags source languages as code and data formats as not", () => {
    expect(isCodeLanguage("python")).toBe(true);
    expect(isCodeLanguage("rust")).toBe(true);
    expect(isCodeLanguage("markdown")).toBe(false);
    expect(isCodeLanguage("json")).toBe(false);
  });
});

describe("extractSymbols — TypeScript/JavaScript", () => {
  it("extracts modern export forms", () => {
    const src = [
      "export const answer = 42;",
      "export async function load() {}",
      "export abstract class Base {}",
      "export interface User {}",
      "export type ID = string;",
      "export enum Color { Red }",
      "export default class App {}",
    ].join("\n");
    expect(extractSymbols(src, "typescript")).toEqual([
      "answer",
      "load",
      "Base",
      "User",
      "ID",
      "Color",
      "App",
    ]);
  });

  it("handles export clauses with aliases", () => {
    const src = "export { a, b as c };\nexport type { Foo, Bar as Baz };";
    expect(extractSymbols(src, "typescript")).toEqual(["a", "c", "Foo", "Baz"]);
  });
});

describe("extractSymbols — other languages", () => {
  it("python: top-level def/class only", () => {
    const src = ["def top():", "    def nested(): pass", "class Widget:", "    def method(self): pass"].join(
      "\n",
    );
    expect(extractSymbols(src, "python")).toEqual(["top", "Widget"]);
  });

  it("rust: pub items and macros", () => {
    const src = [
      "pub fn run() {}",
      "    pub async fn helper() {}",
      "pub struct Config;",
      "pub enum State {}",
      "pub trait Codec {}",
      "macro_rules! my_macro {}",
      "fn private() {}",
    ].join("\n");
    expect(extractSymbols(src, "rust")).toEqual([
      "run",
      "helper",
      "Config",
      "State",
      "Codec",
      "my_macro",
    ]);
  });

  it("go: funcs, methods and types", () => {
    const src = ["package main", "func main() {}", "func (s *Server) Serve() {}", "type Server struct{}", "type Handler interface{}"].join(
      "\n",
    );
    expect(extractSymbols(src, "go")).toEqual(["main", "Serve", "Server", "Handler"]);
  });

  it("java / kotlin / csharp: type declarations", () => {
    expect(extractSymbols("public final class Service {}", "java")).toEqual(["Service"]);
    expect(extractSymbols("public interface Repo {}", "java")).toEqual(["Repo"]);
    expect(extractSymbols("data class Point(val x: Int)", "kotlin")).toEqual(["Point"]);
    expect(extractSymbols("public sealed class Order {}", "csharp")).toEqual(["Order"]);
  });

  it("ruby / php / swift / scala: declarations", () => {
    expect(extractSymbols("def run\nend\nclass Foo\nend\nmodule Bar\nend", "ruby")).toEqual([
      "run",
      "Foo",
      "Bar",
    ]);
    expect(extractSymbols("<?php\nfunction run(){}\nclass Foo {}", "php")).toEqual(["run", "Foo"]);
    expect(extractSymbols("func run() {}\nstruct Point {}", "swift")).toEqual(["run", "Point"]);
    expect(extractSymbols("def run(): Unit = {}\nobject Main", "scala")).toEqual(["run", "Main"]);
  });

  it("c / cpp / shell / lua: declarations", () => {
    expect(extractSymbols("struct Point { int x; };\nint main() {}", "c")).toEqual(["Point"]);
    expect(extractSymbols("class Widget {};\nenum Color { RED };", "cpp")).toEqual(["Widget", "Color"]);
    expect(extractSymbols("function deploy() {\n}\ncleanup() {\n}", "shell")).toEqual([
      "deploy",
      "cleanup",
    ]);
    expect(extractSymbols("function M.run()\nend", "lua")).toEqual(["M.run"]);
  });

  it("data formats produce no symbols", () => {
    expect(extractSymbols('{"a": 1}', "json")).toEqual([]);
    expect(extractSymbols("# Title", "markdown")).toEqual([]);
  });

  it("caps symbols per file", () => {
    const src = Array.from({ length: MAX_SYMBOLS_PER_FILE + 20 }, (_, i) => `export const v${i} = ${i};`).join(
      "\n",
    );
    expect(extractSymbols(src, "typescript")).toHaveLength(MAX_SYMBOLS_PER_FILE);
  });
});
