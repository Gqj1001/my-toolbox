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
 * 行为契约（`tests/date-input.test.mjs` 用一份「老实现副本」逐条钉住了它）：
 *   · `2026-10-03`      → 原样返回（**★ 2026-10 起会校验是不是真实存在的一天**，见下）
 *   · `10月3日` / `10月3` → 当年 + 该月日
 *   · `10-3` / `10/3` / `10.3` → 当年 + 该月日
 *   · `2026年10月7日`    → `2026-10-07`（**2026-10 新增**，见下）
 *   · **不是真实存在的一天**（`2026-13-45` / `2026-02-30` / `2月30日` / `0000-01-01`） → `null`
 *   · 其它任何输入（`周三` / 空 / `abc` / 非字符串） → `null`
 *
 * ⚠️ **`年月日` 是 2026-10 增加的、刻意改变行为的一项**（阶段3 接入统一学生 API 的前置）：
 *    paper-analysis 的「考试日期」默认值就是 `2026年10月7日` 这种带年份的写法，
 *    而老实现只认 `10月3日`（没有年份）→ 带年份的一律返回 `null`，
 *    于是迁移到 `feedback_history.date` 时**日期会静默变空**（用户明确要求不许静默丢数据）。
 *    所以这里补上带年份的分支；**带的年份用它自己的**，不再套当年。
 *    `tests/date-input.test.mjs` 里那份老实现副本**仍然保持原样**，
 *    并新增一组「老实现返回 null、新实现返回 ISO」的**有意分歧**断言 —— 那正是它存在的意义。
 *
 * ⚠️ **非法日期返回 `null` 是 2026-10 第二次刻意改变行为的一项**（修「非法 ISO 导致 500」）：
 *    老实现对 ISO 那条分支**只做正则匹配就原样返回**，于是 `2026-13-45` 被原样交给
 *    `feedback_history.date` → PostgreSQL 拒绝（`22008`）→ **整个写入请求 500**。
 *    更隐蔽的是 `2026-02-30` / `2月30日` 这种「月日数字看着正常、但那一天不存在」的值
 *    （老实现的 1–12 / 1–31 范围校验挡不住），一样会 500。
 *    现在三条分支**共用同一套真日历校验**（闰年、每月天数都算），非法一律 `null`
 *    —— 该列可空，写入照常成功，**不再因为一个手填日期把整条记录弄丢**。
 *
 *    校验口径**按 PostgreSQL 的实测行为对齐**（用只读查询逐条问过库，见
 *    `docs/perf-notes.md`「七、已知问题」）：库接受 `0001-01-01`、`2024-02-29`，
 *    拒绝 `0000-01-01`、`2026-02-29`、`2026-04-31`、`2026-10-32`。
 *    所以这里要求**年份 1–9999、月 1–12、日必须是那个月真实存在的日子**。
 *
 *    `tests/date-input.test.mjs` 里那份老实现副本**仍然保持原样**，
 *    并新增一组「老实现返回原串、新实现返回 null」的**有意分歧**断言 —— 那正是它存在的意义。
 */

/**
 * 这个年月日**在数据库里真的存在**吗？
 *
 * 口径按 PostgreSQL 的实测行为对齐（见文件头注释）：
 *   年份 1–9999、月 1–12、日必须是那个月真实存在的日子（含闰年）。
 *
 * 实现用「日期回环」：让 `Date` 自己进位（`2026-02-30` → `2026-03-02`），
 * 再比对年月日有没有被改动过 —— 动了就说明输入那天不存在。
 * ⚠️ 必须用 `setUTCFullYear()`，**不能**用 `Date.UTC(y, …)`：后者把 0–99 当成 19xx，
 *    会让 `0026-01-01` 这类值被悄悄判错。
 */
function isRealDate(year: number, m: number, d: number): boolean {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return false;
  if (!Number.isInteger(m) || m < 1 || m > 12) return false;
  if (!Number.isInteger(d) || d < 1 || d > 31) return false;

  const dt = new Date(0);
  dt.setUTCHours(0, 0, 0, 0);
  dt.setUTCFullYear(year, m - 1, d);
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 把解析出来的年月日拼成 `YYYY-MM-DD`；那一天不存在（越界 / 假日期 / 0000 年）返回 null */
function toIso(year: number, m: number, d: number): string | null {
  if (!isRealDate(year, m, d)) return null;
  // ⚠️ 年份也要补零到 4 位：`0001-01-01` 不补就拼成 `1-01-01`，
  //    那不是 ISO、也不是库能认的写法（本项目的测试抓到过这个 bug）。
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 用户输入的日期文本 → `YYYY-MM-DD`；无法解析时返回 `null`（该列可为空） */
export function parseDisplayDate(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  // 已是 ISO：**年月日都要拆出来校验**，不能像老实现那样「匹配上就原样返回」
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 带年份的中文写法：`2026年10月7日` / `2026年10月7`（★ 2026-10 新增）
  // ⚠️ 必须排在「不带年份」那条**前面**，否则 `年` 会被当成无关字符而匹配失败。
  const cnY = raw.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/);
  if (cnY) return toIso(Number(cnY[1]), Number(cnY[2]), Number(cnY[3]));

  const year = new Date().getFullYear();
  const cn = raw.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日?$/);
  if (cn) return toIso(year, Number(cn[1]), Number(cn[2]));

  const sep = raw.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (sep) return toIso(year, Number(sep[1]), Number(sep[2]));

  // 其它格式（如「周三」）不写入日期列，避免整条记录写入失败
  return null;
}
