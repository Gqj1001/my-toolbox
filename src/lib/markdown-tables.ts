/**
 * 学情报告里的 **Markdown 表格**解析（纯函数，客户端/测试共用）
 *
 * 为什么需要：AI 报告现在允许输出 Markdown 表格（分数趋势 / 学习进度 / 目标对比），
 * 但报告整体仍是一段纯文本，不能直接把 `| a | b |` 丢给用户看。
 * 这里只识别**规整的 pipe 表格**：
 *
 *   | 月份 | 得分率 |
 *   | --- | ---: |
 *   | 9月 | 62% |
 *
 * 其它内容原样作为文本块；不做 HTML、不执行任何标记，React 渲染时会自动转义。
 */

export type ReportBlock =
  | { type: "text"; text: string }
  | { type: "table"; headers: string[]; rows: string[][] };

function isPipeLine(line: string): boolean {
  const s = line.trim();
  if (!s.includes("|")) return false;
  // 至少两个分隔符（| a | b |）才算表格行，避免把正文里的一个竖线误判
  return s.startsWith("|") && s.endsWith("|") && s.split("|").length >= 3;
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isSeparator(line: string): boolean {
  if (!isPipeLine(line)) return false;
  const cs = cells(line);
  return cs.length > 0 && cs.every((c) => /^:?-{3,}:?$/.test(c));
}

export function parseMarkdownTables(input: string): ReportBlock[] {
  const lines = String(input ?? "").split(/\r?\n/);
  const out: ReportBlock[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    if (!textBuf.length) return;
    const text = textBuf.join("\n").replace(/^\n+|\n+$/g, "");
    if (text) out.push({ type: "text", text });
    textBuf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!isPipeLine(line) || i + 1 >= lines.length || !isSeparator(lines[i + 1])) {
      textBuf.push(line);
      continue;
    }

    flushText();
    const headers = cells(line);
    const rows: string[][] = [];
    i += 2; // 跳过表头 + 分隔行
    while (i < lines.length && isPipeLine(lines[i])) {
      const row = cells(lines[i]);
      // 列数不一致时按表头补齐/截断，避免渲染时错位
      rows.push(headers.map((_, idx) => row[idx] ?? ""));
      i++;
    }
    i--; // for 循环会再加 1
    out.push({ type: "table", headers, rows });
  }

  flushText();
  return out;
}
