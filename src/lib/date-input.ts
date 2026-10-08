/**
 * 前端「显示型日期」→ date 列可接受的 ISO 格式。
 *
 * ⚠️ **本文件是从 `src/app/api/feedback/data/route.ts` 原样搬出来的**
 *    （阶段2 第2步的「抽公共函数」）。搬移时**一个字符都没改**，只加了 `export`
 *    与这段说明。原因是它已经在线上的写路径上跑着：feedback 的「存历史」依赖它，
 *    改错了会让日期**静默变成 null**（不报错、数据就丢了）。
 *
 * 为什么值得单独成文件：三个工具都有「用户填给人看的日期」这件事
 *   （feedback 的 `dateInput`、paper-analysis 的 `examDate`），
 *   而这两个工具都要往 `feedback_history.date` 里写。所以这套解析必须**只有一份**。
 *
 * 行为契约（**别改**，`tests/date-input.test.mjs` 用一份「老实现副本」逐条钉住了它）：
 *   · `2026-10-03`      → 原样返回（正则匹配即通过，**不校验月/日是否合法**）
 *   · `10月3日` / `10月3` → 当年 + 该月日
 *   · `10-3` / `10/3` / `10.3` → 当年 + 该月日
 *   · 月不在 1–12 或日不在 1–31 → `null`
 *   · 其它任何输入（`周三` / 空 / `abc` / 非字符串） → `null`
 *
 * ⚠️ **已知问题（本轮不修，见 docs/perf-notes.md「已知问题」）**：
 *    因为是「正则匹配即原样返回」，`2026-13-45` 这种**非法 ISO 也会被原样写库**，
 *    然后被 PostgreSQL 拒绝 → 整个请求 500。这是搬移**之前就存在**的行为，
 *    本轮刻意不动（用户明确要求行为零改动），将来单独修。
 */

/** 用户输入的日期文本 → `YYYY-MM-DD`；无法解析时返回 `null`（该列可为空） */
export function parseDisplayDate(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  // 已是 ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const year = new Date().getFullYear();
  const cn = raw.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/);
  if (cn) {
    const m = Number(cn[1]);
    const d = Number(cn[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return null;
  }

  const sep = raw.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (sep) {
    const m = Number(sep[1]);
    const d = Number(sep[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
    return null;
  }

  // 其它格式（如「周三」）不写入日期列，避免整条记录写入失败
  return null;
}
