import { pc } from "./colors";

const CONTEXT_LINES = 3;
const MAX_DIFF_LINES = 100;

interface DiffLine {
  type: "context" | "remove" | "add";
  oldNum: number | null;
  newNum: number | null;
  content: string;
}

function computeLCS(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

function buildDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const dp = computeLCS(oldLines, newLines);
  const result: DiffLine[] = [];
  let i = oldLines.length;
  let j = newLines.length;

  const raw: Array<{
    type: "context" | "remove" | "add";
    oldNum: number;
    newNum: number;
    content: string;
  }> = [];

  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      raw.unshift({
        type: "context",
        oldNum: i,
        newNum: j,
        content: oldLines[i - 1],
      });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      raw.unshift({
        type: "remove",
        oldNum: i,
        newNum: 0,
        content: oldLines[i - 1],
      });
      i--;
    } else {
      raw.unshift({
        type: "add",
        oldNum: 0,
        newNum: j,
        content: newLines[j - 1],
      });
      j--;
    }
  }

  while (i > 0) {
    raw.unshift({
      type: "remove",
      oldNum: i,
      newNum: 0,
      content: oldLines[i - 1],
    });
    i--;
  }

  while (j > 0) {
    raw.unshift({
      type: "add",
      oldNum: 0,
      newNum: j,
      content: newLines[j - 1],
    });
    j--;
  }

  const changed = new Set<number>();
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].type !== "context") {
      changed.add(k);
    }
  }

  const included = new Set<number>();
  for (const idx of changed) {
    for (
      let k = Math.max(0, idx - CONTEXT_LINES);
      k <= Math.min(raw.length - 1, idx + CONTEXT_LINES);
      k++
    ) {
      included.add(k);
    }
  }

  let lastIncluded = -1;
  for (let k = 0; k < raw.length; k++) {
    if (included.has(k)) {
      if (lastIncluded >= 0 && k > lastIncluded + 1) {
        result.push({
          type: "context",
          oldNum: null,
          newNum: null,
          content: "...",
        });
      }
      const line = raw[k];
      result.push({
        type: line.type,
        oldNum: line.type === "add" ? null : line.oldNum,
        newNum: line.type === "remove" ? null : line.newNum,
        content: line.content,
      });
      lastIncluded = k;
    }
  }

  return result;
}

function formatLine(line: DiffLine, maxNumWidth: number): string {
  const num = line.type === "remove" ? line.oldNum : line.newNum;
  const numStr =
    num !== null ? String(num).padStart(maxNumWidth) : " ".repeat(maxNumWidth);

  if (line.type === "remove") {
    return `${numStr} ${pc.red("-")} ${line.content}`;
  } else if (line.type === "add") {
    return `${numStr} ${pc.green("+")} ${line.content}`;
  } else if (line.content === "...") {
    return pc.dim(`  ${" ".repeat(maxNumWidth)}...`);
  } else {
    return `  ${numStr}   ${line.content}`;
  }
}

export function generateDiff(oldContent: string, newContent: string): string {
  if (oldContent === newContent) return "";

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  if (
    oldLines.length === 1 &&
    oldLines[0] === "" &&
    newLines.length === 1 &&
    newLines[0] === ""
  ) {
    return "";
  }

  const diff = buildDiff(oldLines, newLines);
  if (diff.length === 0) return "";

  const maxOldNum = Math.max(
    ...diff.filter((l) => l.oldNum !== null).map((l) => l.oldNum!),
  );
  const maxNewNum = Math.max(
    ...diff.filter((l) => l.newNum !== null).map((l) => l.newNum!),
  );
  const maxNumWidth = Math.max(
    String(maxOldNum).length,
    String(maxNewNum).length,
    3,
  );

  let lines = diff.map((l) => formatLine(l, maxNumWidth));

  if (lines.length > MAX_DIFF_LINES) {
    const truncated = lines.slice(0, MAX_DIFF_LINES);
    truncated.push(
      pc.dim(`  ... (${lines.length - MAX_DIFF_LINES} more lines)`),
    );
    lines = truncated;
  }

  return lines.join("\n");
}

export function generateNewFileDiff(content: string): string {
  const lines = content.split("\n");
  const maxNumWidth = Math.max(String(lines.length).length, 3);

  const diffLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const numStr = String(i + 1).padStart(maxNumWidth);
    diffLines.push(
      `${numStr} ${pc.green("+")} ${lines[i]}`,
    );
  }

  if (diffLines.length > MAX_DIFF_LINES) {
    const truncated = diffLines.slice(0, MAX_DIFF_LINES);
    truncated.push(
      pc.dim(`  ... (${diffLines.length - MAX_DIFF_LINES} more lines)`),
    );
    return truncated.join("\n");
  }

  return diffLines.join("\n");
}

export function generateDeleteDiff(content: string): string {
  const lines = content.split("\n");
  const maxNumWidth = Math.max(String(lines.length).length, 3);

  const diffLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const numStr = String(i + 1).padStart(maxNumWidth);
    diffLines.push(
      `${numStr} ${pc.red("-")} ${lines[i]}`,
    );
  }

  if (diffLines.length > MAX_DIFF_LINES) {
    const truncated = diffLines.slice(0, MAX_DIFF_LINES);
    truncated.push(
      pc.dim(`  ... (${diffLines.length - MAX_DIFF_LINES} more lines)`),
    );
    return truncated.join("\n");
  }

  return diffLines.join("\n");
}

export function generateMoveDiff(fromPath: string, toPath: string): string {
  return [
    pc.red(`  - ${fromPath}`),
    pc.green(`  + ${toPath}`),
  ].join("\n");
}
