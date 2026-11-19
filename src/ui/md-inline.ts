// Подсветка кода и inline-разметка markdown — вынесено из `md-formatter.ts`
// (правило ≤300).
import { pc } from "./colors";

const KW =
  /\b(import|export|from|const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|implements|interface|type|enum|namespace|module|declare|abstract|async|await|yield|throw|try|catch|finally|typeof|instanceof|in|of|as|is|keyof|readonly|static|private|public|protected|get|set|constructor|this|super|void|never|any|unknown|boolean|string|number|symbol|object|true|false|null|undefined|default)\b/g;
const STRING = /('[^']*'|"[^"]*"|`[^`]*`)/g;
const COMMENT = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)/g;
const NUMBER = /\b(\d+\.?\d*)\b/g;
const TAG = /<\/?([A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9-]*)/g;
const ATTR = /\b([a-zA-Z-]+=)"([^"]*)"/g;

/** Подсветить код по языку (приблизительная лексическая подсветка). */
export function highlight(code: string, lang: string): string {
  if (lang === "html" || lang === "xml" || lang === "svg") {
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)));
    code = code.replace(ATTR, (_m, attr, val) => `${pc.yellow(attr)}=${pc.green(`"${val}"`)}`);
    code = code.replace(TAG, (_m, tag) => `<${pc.cyan(tag)}`);
  } else if (lang === "css" || lang === "scss" || lang === "less") {
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)));
    code = code.replace(STRING, (m) => pc.green(m));
    code = code.replace(NUMBER, (m) => pc.yellow(m));
  } else if (lang === "bash" || lang === "sh" || lang === "shell" || lang === "zsh") {
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)));
    code = code.replace(STRING, (m) => pc.green(m));
  } else if (lang === "json") {
    code = code.replace(STRING, (m) => pc.green(m));
    code = code.replace(NUMBER, (m) => pc.yellow(m));
  } else {
    // js, ts, jsx, tsx, and fallback
    code = code.replace(COMMENT, (m) => pc.dim(pc.green(m)));
    code = code.replace(STRING, (m) => pc.green(m));
    code = code.replace(KW, (m) => pc.magenta(m));
    code = code.replace(NUMBER, (m) => pc.yellow(m));
  }

  return code;
}

/** Inline-разметка: code-spans, bold/italic/strike, ссылки. */
export function formatInline(text: string): string {
  const codeSpans: string[] = [];
  let result = text.replace(/`([^`]+)`/g, (_m, c) => {
    codeSpans.push(pc.yellow(c));
    return `\u0000${codeSpans.length - 1}\u0000`;
  });

  // `***text***` (bold+italic) до одиночных `**`/`*`, иначе вложенность
  // рвётся и во вложении остаётся висящая звёздочка.
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, (_, s) => pc.bold(pc.italic(s)));
  result = result.replace(/\*\*(.+?)\*\*/g, (_, s) => pc.bold(s));
  result = result.replace(/~~(.+?)~~/g, (_, s) => pc.strikethrough(s));
  result = result.replace(/\*([^*]+)\*/g, (_, s) => pc.italic(s));
  result = result.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, (_m, pre, s) => pre + pc.italic(s));
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    const short = url.length > 80 ? `${url.slice(0, 77)}…` : url;
    return `${pc.cyan(label)} ${pc.dim(`(${short})`)}`;
  });

  result = result.replace(/\u0000(\d+)\u0000/g, (_m, i) => codeSpans[Number(i)]);
  return result;
}
