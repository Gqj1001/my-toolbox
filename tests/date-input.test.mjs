/**
 * `parseDisplayDate` 搬移的对照测试（阶段2 第2步）
 *
 * 背景：这个函数从 `src/app/api/feedback/data/route.ts` 搬到了 `src/lib/date-input.ts`。
 * 它在**写路径**上 —— 解析错了不会报错，日期会**静默变成 null**（数据就丢了）。
 * 所以要求是「行为零改动」，而且必须**可执行地**证明，不能靠肉眼 diff。
 *
 * 两组证据：
 *   A. 对照测试：本文件里留一份**老实现的逐字副本**，让它与**生产代码里的新实现**
 *      对同一批输入求值，逐条比对。新实现在服务端，所以通过只读调试口
 *      `/api/debug/parse-date` 调。
 *      ⚠️ **调试口没配置就跳过这一组**（生产环境不配它，测试不能因此变红）；
 *         跳过时会明确打印「已跳过」，不会假装通过。
 *   B. 端到端测试：真的 POST 一条历史（走 route.ts 的写路径），再从库里读回
 *      `date` 列，断言它就是老实现算出来的值。这组**不依赖调试口**，永远跑。
 *
 * ★ 2026-10 第二批（修「非法日期 → 500」）新增两组：
 *   A3/A4 与 B3 —— 见下面各自块注释。核心是「**有意分歧**」：
 *   老实现放行的非法日期（`2026-13-45` / `2026-02-30` / `2月30日` / `0000-01-01`）
 *   新实现一律返回 null；同时**反向防护**真的存在的日子（闰年、0001/9999 年）不被误伤。
 *
 * 跑法：
 *   & "<bundled node>" tests\date-input.test.mjs
 * ⚠️ 它自己起 next start（端口 3000）并杀掉旧监听，别和其它真服务套件同时跑。
 */
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder } from "./_helpers.mjs";
import { DEBUG_TOKEN, ensureServer, loginCookie } from "./_students-baseline.mjs";

const BASE = "http://127.0.0.1:3000";
const DEBUG_URL = `${BASE}/api/debug/parse-date`;
const { record, summary } = makeRecorder();

/* ==========================================================================
   老实现：从 src/app/api/feedback/data/route.ts 搬移**之前**的逐字副本
   --------------------------------------------------------------------------
   ⚠️ 这是本测试的「参照物」，**不要**为了让它跟新实现一致而修改它。
      它就是「搬移前线上跑的那份代码」。两边不一致 = 行为被改过。
   ⚠️ **2026-10（阶段3）有意改了行为**：新实现多了「带年份的中文写法」
      （`2026年10月7日` → `2026-10-07`）。paper-analysis 的考试日期默认就是这个写法，
      老实现返回 null → 迁移到 feedback_history.date 时日期会**静默变空**。
      这份老副本**依然不动**，改动体现在下面「A2. 有意分歧」那一组断言里。
   ========================================================================== */
function parseDisplayDateOLD(input) {
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

/** 对照用的输入表（含边界与「看起来像但不是」的输入） */
const CASES = [
  // ---- 正常：ISO ----
  "2026-10-03", "2026-01-01", "2026-12-31", "1999-02-28",
  // ★ 2026-10 新增的边界（真日历校验**不能误伤**这些真的存在的日子）
  //   0001-01-01 / 9999-12-31 都用只读查询问过库：**接受**（见 docs/perf-notes.md 七）
  "2024-02-29", "2026-02-28", "0001-01-01", "9999-12-31",
  // ---- 正常：中文 ----
  "10月3日", "10月3", "10月03日", "1月1日", "12月31日", "10 月 3 日", "10月3日  ",
  // ---- 正常：分隔符 ----
  "10-3", "10/3", "10.3", "1-1", "12-31", "03-09", "3.16",
  // ---- 范围边界（应 null）----
  "0月5日", "13月1日", "10月0日", "10月32日", "00-05", "13-01", "10-32",
  // ---- 空 / 无意义（应 null）----
  "", "   ", "\t\n", null, undefined,
  // ---- 非字符串 ----
  20261003, 103, 0, true, false, {}, [], ["10月3日"],
  // ---- 像但不是 ----
  "周三", "abc", "10月", "10", "-3", "10-", "10--3", "2026-1-1", "2026/10/03",
  "2026-10-03T00:00:00", "3.16-20", "4/24", "10月3日（周三）", "约10月3日",
];

/**
 * ★ 2026-10 新增、**有意与老实现分歧**的输入（阶段3 的前置改动）
 *
 * 这些就是 paper-analysis「考试日期」输入框的默认形状。
 * 老实现只认 `10月3日`（没有年份）→ 带年份一律 null → 迁移时日期**静默变空**。
 * 新实现补上带年份的分支，**并用它自己的年份**。
 */
const CASES_NEW_ONLY = [
  ["2026年10月7日", "2026-10-07"],
  ["2026年10月7", "2026-10-07"],
  ["2026 年 10 月 7 日", "2026-10-07"],
  ["2026年1月1日", "2026-01-01"],
  ["2026年12月31日", "2026-12-31"],
  ["1999年2月28日", "1999-02-28"],
  // 越界仍然必须是 null（不能因为「带了年份」就放行）
  ["2026年13月1日", null],
  ["2026年10月32日", null],
  ["2026年0月5日", null],
  ["2026年10月0日", null],
  // 不完整的年月写法不认（避免误判）
  ["2026年10月", null],
];

/* ==========================================================================
   ★ 2026-10 第二批：**有意与老实现分歧**的「非法日期」（修「非法日期导致 500」）

   老实现的问题：ISO 那条分支**只做正则匹配就原样返回**，而中文/分隔符分支只有
   「月 1–12、日 1–31」这种粗校验 —— 于是下面这些值会被原样交给
   `feedback_history.date`，PostgreSQL 一律拒绝（22008）→ **整个写入请求 500**。

   ⚠️ 注意 `2026-02-30` / `2026-02-29`(2026 非闰年) / `2月30日` 这几条：
      它们**过了**老的 1–12 / 1–31 范围校验，所以只加范围校验挡不住 ——
      必须做「那一天真的存在吗」的日历校验。这就是当初选 B 方案而不是 A 的理由。

   ⚠️ 这一组红 = 「非法日期又能写库了」→ 线上会重新出现 500。
   ========================================================================== */
const CASES_BAD_DATE = [
  "2026-13-45",   // 月日双越界（用户报的那条）
  "2026-13-01",   // 只有月越界
  "2026-00-10",   // 月为 0
  "2026-10-00",   // 日为 0
  "2026-10-32",   // 日 32
  "2026-02-30",   // ★ 2 月没有 30 号（老的 1–31 校验挡不住）
  "2026-04-31",   // ★ 4 月没有 31 号（同上）
  "2026-02-29",   // ★ 2026 不是闰年（同上）
  "0000-01-01",   // ★ 库实测拒绝 0000 年（`0001-01-01` 才接受）
  "2月30日",       // 中文分支：老实现会拼出 2026-02-30
  "4月31日",       // 中文分支同上
  "2-30",         // 分隔符分支同上
];

/* ==========================================================================
   主流程
   ========================================================================== */
let srv = null;
try {
  srv = await ensureServer();
  record("next start 起来了", true);
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { if ((await fetch(`${BASE}/login`)).status === 200) { up = true; break; } } catch {}
  }
  if (!up) throw new Error("服务器没起来");

  const { adminEmail, password } = readUsers();
  const cookie = await loginCookie(adminEmail, password);
  record("用真会话登录成功", !!cookie);

  // ---------------------------------------------------------------- 调试口可用性探测
  const probe = await fetch(`${DEBUG_URL}?input=${encodeURIComponent("10月3日")}`, {
    headers: { "x-debug-token": DEBUG_TOKEN, cookie },
  }).catch(() => null);
  const probeBody = probe ? await probe.json().catch(() => null) : null;
  const debugUsable = !!(probe?.ok && probeBody?.ok);
  record(
    `调试口 /api/debug/parse-date 探测（status=${probe?.status ?? "无响应"}）→ ` +
      (debugUsable ? "可用，将跑对照测试" : "未配置，**跳过对照测试**（符合预期，不算失败）"),
    true,
  );

  // ---------------------------------------------------------------- A. 对照测试
  if (debugUsable) {
    const mismatches = [];
    const oldVsNew = [];
    for (const c of CASES) {
      // 老实现（本地副本）
      const oldR = parseDisplayDateOLD(c);
      // 新实现（生产代码，经只读调试口）
      // ⚠️ 入参与生产一致：前端传来的是字符串；null/undefined 在这里用「不发 input」表达
      const qs = c === null || c === undefined
        ? ""
        : `?input=${encodeURIComponent(typeof c === "string" ? c : String(c))}`;
      const r = await fetch(`${DEBUG_URL}${qs}`, { headers: { "x-debug-token": DEBUG_TOKEN, cookie } });
      const b = await r.json().catch(() => null);
      const newR = b?.result ?? null;
      if (oldR !== newR) mismatches.push({ input: c, old: oldR, neu: newR });
      oldVsNew.push(`  ${JSON.stringify(c)}: 老=${JSON.stringify(oldR)} 新=${JSON.stringify(newR)}`);
    }
    record(`★对照：${CASES.length} 个输入，新老实现**逐条完全一致**`,
      mismatches.length === 0,
      mismatches.length
        ? `不一致 ${mismatches.length} 条：` + mismatches.map((m) => `${JSON.stringify(m.input)}(老${JSON.stringify(m.old)}/新${JSON.stringify(m.neu)})`).join(" ")
        : "（全部一致）");
    // 打印明细，方便人工核对边界
    record("对照明细（供人工核对边界）", true, "\n" + oldVsNew.join("\n"));

    // ---------------------------------------------------------------- A2. 有意分歧（2026-10 新增）
    // 老实现对「带年份的中文写法」一律返回 null；新实现必须给出正确 ISO。
    // ⚠️ 这一组红 = 「年月日」支持被弄坏了（阶段3 的迁移会因此**静默丢日期**）。
    {
      const bad = [];
      for (const [inp, exp] of CASES_NEW_ONLY) {
        const newR = await (await fetch(
          `${DEBUG_URL}?input=${encodeURIComponent(inp)}`,
          { headers: { "x-debug-token": DEBUG_TOKEN, cookie } },
        )).json().then((b) => b?.result ?? null).catch(() => "<请求失败>");
        if (newR !== exp) bad.push(`${JSON.stringify(inp)}: 期望${JSON.stringify(exp)} 实际${JSON.stringify(newR)}`);
        // 顺带确认「老实现确实做不到」——这正是这次改行为的理由
        const oldR = parseDisplayDateOLD(inp);
        if (exp !== null && oldR !== null) {
          bad.push(`${JSON.stringify(inp)}: 老实现也认（${JSON.stringify(oldR)}）→ 说明这条不该归入「新增」`);
        }
      }
      record(`★有意分歧：${CASES_NEW_ONLY.length} 个「年月日」输入按新契约解析（老实现做不到）`,
        bad.length === 0, bad.length ? bad.join(" | ") : "（含越界仍为 null 的用例）");
    }

    // ---------------------------------------------------------------- A3. 有意分歧：非法日期
    // ★ 2026-10 第二批：新实现必须把「那一天不存在」的输入一律变成 null；
    //    同时**逐条确认老实现确实会放行** —— 否则这组断言会退化成「两边都 null」的空过，
    //    看着全绿、其实什么都没钉住（本项目踩过这类假绿）。
    {
      const bad = [];
      const lines = [];
      for (const inp of CASES_BAD_DATE) {
        const newR = await (await fetch(
          `${DEBUG_URL}?input=${encodeURIComponent(inp)}`,
          { headers: { "x-debug-token": DEBUG_TOKEN, cookie } },
        )).json().then((b) => b?.result ?? null).catch(() => "<请求失败>");
        const oldR = parseDisplayDateOLD(inp);
        lines.push(`  ${JSON.stringify(inp)}: 老=${JSON.stringify(oldR)} 新=${JSON.stringify(newR)}`);
        if (newR !== null) bad.push(`${JSON.stringify(inp)}: 新实现应 null，实际 ${JSON.stringify(newR)}`);
        // 老实现必须**放行**（返回非 null）—— 这正是「500 的来源」，也是这次改行为的理由
        if (oldR === null) bad.push(`${JSON.stringify(inp)}: 老实现也返回 null → 这条不该归入「非法日期分歧」`);
      }
      record(`★有意分歧：${CASES_BAD_DATE.length} 个「那一天不存在」的输入 → 新实现 null（老实现会放行 → 写库 500）`,
        bad.length === 0, bad.length ? bad.join(" | ") : "（含 2 月 30 日 / 非闰年 2 月 29 日 / 0000 年）");
      record("★非法日期明细（供人工核对：老 vs 新）", true, "\n" + lines.join("\n"));
    }

    // ---------------------------------------------------------------- A4. 反向防护：真的存在的日子不能误伤
    // ⚠️ 真日历校验最容易犯的错是「顺手把闰年 / 边界年份也挡了」——
    //    那会把老师填的合法日期**静默变空**（比 500 更难发现）。所以单独钉一条。
    {
      // ⚠️ 期望值写死（不能拿老实现当参照：`2026年10月7日` 正是「老实现返回 null」的那一类）
      const y = new Date().getFullYear();
      const MUST_KEEP = [
        ["2026-10-03", "2026-10-03"],
        ["2024-02-29", "2024-02-29"],   // 闰年
        ["2026-02-28", "2026-02-28"],
        ["0001-01-01", "0001-01-01"],   // 库实测接受的最小年
        ["9999-12-31", "9999-12-31"],   // 四位数年份的上界
        ["2026年10月7日", "2026-10-07"],
        ["10月3日", `${y}-10-03`],
        ["10-3", `${y}-10-03`],
      ];
      const bad = [];
      for (const [inp, expected] of MUST_KEEP) {
        const newR = await (await fetch(
          `${DEBUG_URL}?input=${encodeURIComponent(inp)}`,
          { headers: { "x-debug-token": DEBUG_TOKEN, cookie } },
        )).json().then((b) => b?.result ?? null).catch(() => "<请求失败>");
        if (newR !== expected) bad.push(`${JSON.stringify(inp)}: 期望${JSON.stringify(expected)} 实际${JSON.stringify(newR)}`);
      }
      record(`★反向防护：${MUST_KEEP.length} 个**真实存在**的日期一个都没被误伤（含闰年 2024-02-29、0001 年、9999 年）`,
        bad.length === 0, bad.length ? bad.join(" | ") : "（与写死的期望值逐条一致）");
    }

    // 顺带钉住几个「契约」值，防止两边一起错
    const expect = {
      "2026-10-03": "2026-10-03",
      "10月3日": `${new Date().getFullYear()}-10-03`,
      "10-3": `${new Date().getFullYear()}-10-03`,
      "13月1日": null,
      "周三": null,
      "": null,
    };
    const contractBad = [];
    for (const [inp, exp] of Object.entries(expect)) {
      const got = parseDisplayDateOLD(inp);
      if (got !== exp) contractBad.push(`${JSON.stringify(inp)}: 期望${JSON.stringify(exp)} 实际${JSON.stringify(got)}`);
    }
    record("★契约：ISO 原样、中文/分隔符补当年、越界与非日期为 null",
      contractBad.length === 0, contractBad.length ? contractBad.join(" | ") : "");
  } else {
    console.log("  （跳过对照测试：调试口未配置。端到端测试仍会跑。）");
  }

  // ---------------------------------------------------------------- B. 端到端写库
  // 真 POST 一条历史 → 从库里读回 date 列 → 必须等于老实现算出来的值
  const { SUPABASE_URL, ANON_KEY } = readEnv();
  const tok = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password }),
  })).json();
  const H = { apikey: ANON_KEY, Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" };

  const STU = "__日期对照探针";
  await fetch(`${SUPABASE_URL}/rest/v1/feedback_history?student_name=eq.${encodeURIComponent(STU)}`, { method: "DELETE", headers: H });

  /** 走真实写路径存一条，返回 {status, storedDate} */
  async function postAndReadBack(input, label) {
    const res = await fetch(`${BASE}/api/feedback/data`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        op: "history", studentName: STU, text: label, subject: "math",
        // ⚠️ 与前端一致：没填日期时这里可能是空串/undefined
        ...(input === undefined ? {} : { date: input }),
      }),
    });
    if (res.status !== 200) return { status: res.status, storedDate: "<请求失败>" };
    const rows = await (await fetch(
      `${SUPABASE_URL}/rest/v1/feedback_history?student_name=eq.${encodeURIComponent(STU)}&text=eq.${encodeURIComponent(label)}&select=date,created_at&order=created_at.desc&limit=1`,
      { headers: H })).json();
    return { status: res.status, storedDate: rows?.[0]?.date ?? null, found: Array.isArray(rows) && rows.length > 0 };
  }

  const E2E = [
    ["2026-10-03", "e2e-iso"],
    ["10月3日", "e2e-cn"],
    ["10月3", "e2e-cn-nori"],
    ["10-3", "e2e-dash"],
    ["10/3", "e2e-slash"],
    ["10.3", "e2e-dot"],
    ["1月1日", "e2e-jan1"],
    ["12月31日", "e2e-dec31"],
    ["13月1日", "e2e-bad-month"],
    ["10月32日", "e2e-bad-day"],
    ["周三", "e2e-weekday"],
    ["", "e2e-empty"],
    [undefined, "e2e-missing"],
    ["abc", "e2e-abc"],
  ];
  const e2eBad = [];
  for (const [input, label] of E2E) {
    const { status, storedDate } = await postAndReadBack(input, label);
    const expected = parseDisplayDateOLD(input === "" ? "" : input);
    const ok = status === 200 && storedDate === expected;
    if (!ok) e2eBad.push(`${JSON.stringify(input)} → 库里=${JSON.stringify(storedDate)} 期望=${JSON.stringify(expected)} status=${status}`);
  }
  record(`★端到端：${E2E.length} 个日期输入，写库后的 date 列与老实现算出的值完全一致`,
    e2eBad.length === 0, e2eBad.length ? e2eBad.join(" | ") : "（含越界/空/非日期 → null 的用例）");

  // ---------------------------------------------------------------- B2. 端到端：新增的「年月日」写法
  // ⚠️ 这一组**不能**再和 parseDisplayDateOLD 比 —— 它就是要和老实现不一样。
  //    期望值写死，证明「带年份的日期真的落进库里了」，而不是静默变 null。
  const E2E_NEW = [
    ["2026年10月7日", "2026-10-07", "e2e-cn-year"],
    ["2026年1月1日", "2026-01-01", "e2e-cn-year-jan1"],
    ["2026年12月31日", "2026-12-31", "e2e-cn-year-dec31"],
    ["2026年13月1日", null, "e2e-cn-year-bad-month"],
  ];
  const e2eNewBad = [];
  for (const [input, expected, label] of E2E_NEW) {
    const { status, storedDate } = await postAndReadBack(input, label);
    if (status !== 200 || storedDate !== expected) {
      e2eNewBad.push(`${JSON.stringify(input)} → 库里=${JSON.stringify(storedDate)} 期望=${JSON.stringify(expected)} status=${status}`);
    }
    // 顺带留痕：老实现对这个输入是 null，所以旧代码搬过去会**丢日期**
    const oldR = parseDisplayDateOLD(input);
    if (expected !== null && oldR !== null) {
      e2eNewBad.push(`${JSON.stringify(input)}: 老实现也认（${JSON.stringify(oldR)}）→ 这条不该在「新增」组`);
    }
  }
  record(`★端到端：${E2E_NEW.length} 个「年月日」写法真的落进 date 列（老实现会丢成 null）`,
    e2eNewBad.length === 0, e2eNewBad.length ? e2eNewBad.join(" | ") : "（含越界仍为 null 的用例）");

  // ---------------------------------------------------------------- B3. 端到端：非法日期不再 500（★ 2026-10 第二批）
  // ⚠️ 这一组才是**真 bug 的防护**：修复前这些值会被原样送进 `feedback_history.date`，
  //    PostgreSQL 报 22008 → 路由整条写入失败 → 前端拿到 **500**、记录全丢。
  //    判据必须是 **HTTP 200 + 库里 date 为 null**（两个都要）：
  //    只看 200 不够（若接口吞掉错误照样 200）；只看 null 也不够（请求根本没成功时也是 null）。
  const E2E_BAD_DATE = [
    ["2026-13-45", "e2e-bad-iso-1345"],     // ← 用户报的那条：修复前 500
    ["2026-13-01", "e2e-bad-iso-m13"],
    ["2026-10-32", "e2e-bad-iso-d32"],
    ["2026-02-30", "e2e-bad-iso-feb30"],    // ← 只加范围校验挡不住的假日期
    ["2026-02-29", "e2e-bad-iso-feb29"],    // ← 2026 非闰年
    ["0000-01-01", "e2e-bad-iso-year0"],
    ["2月30日", "e2e-bad-cn-feb30"],         // ← 中文分支同一个洞
  ];
  const e2eBadDateFail = [];
  for (const [input, label] of E2E_BAD_DATE) {
    const { status, storedDate } = await postAndReadBack(input, label);
    if (status !== 200 || storedDate !== null) {
      e2eBadDateFail.push(`${JSON.stringify(input)} → status=${status} 库里=${JSON.stringify(storedDate)}（期望 200 + null）`);
    }
  }
  record(`★端到端：${E2E_BAD_DATE.length} 个非法日期**不再 500**（HTTP 200 且 date 落成 null，记录不丢）`,
    e2eBadDateFail.length === 0,
    e2eBadDateFail.length ? e2eBadDateFail.join(" | ") : "（修复前这些全是 500）");

  // ---------------------------------------------------------------- C. 修复留痕（★ 2026-10 第二批）
  // 这里原来记的是「已知问题：非法 ISO 被原样返回」。
  // 现在这个行为**已被修掉**，而参照物（老实现副本）**故意保持原样** ——
  // 两条一起断言，才说明「是**有意**改的行为」，而不是参照物被人改过、两边一起错。
  {
    const oldR = parseDisplayDateOLD("2026-13-45");
    const newR = debugUsable
      ? await (await fetch(`${DEBUG_URL}?input=${encodeURIComponent("2026-13-45")}`,
          { headers: { "x-debug-token": DEBUG_TOKEN, cookie } })).json().then((b) => b?.result ?? null).catch(() => "<请求失败>")
      : "<调试口未配置，未测>";
    record("★修复留痕：非法 ISO「2026-13-45」老实现原样返回（参照物未被改动）、新实现返回 null",
      oldR === "2026-13-45" && (!debugUsable || newR === null),
      `老=${JSON.stringify(oldR)} / 新=${JSON.stringify(newR)}`);
  }

  // ---------------------------------------------------------------- 清理
  await fetch(`${SUPABASE_URL}/rest/v1/feedback_history?student_name=eq.${encodeURIComponent(STU)}`, { method: "DELETE", headers: H });
  const left = await (await fetch(
    `${SUPABASE_URL}/rest/v1/feedback_history?student_name=eq.${encodeURIComponent(STU)}&select=id`, { headers: H })).json();
  record("探针数据已清理（线上不留垃圾）", Array.isArray(left) && left.length === 0, `剩余=${JSON.stringify(left)}`);
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
} finally {
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }"],
    { encoding: "utf8" });
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
