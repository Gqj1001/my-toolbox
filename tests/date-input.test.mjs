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
      它就是「搬移前线上跑的那份代码」。两边不一致 = 搬移改变了行为 = 测试该红。
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

  // ---------------------------------------------------------------- C. 已知问题（记录，不断言 500）
  // `2026-13-45` 这种非法 ISO 会被**原样写库**，再由 PostgreSQL 拒绝。
  // 这是搬移前就有的行为，本轮不动（见 docs/perf-notes.md「已知问题」）。
  record("已知问题留痕：非法 ISO 被原样返回（不校验月/日），这是既有行为",
    parseDisplayDateOLD("2026-13-45") === "2026-13-45",
    `parseDisplayDateOLD("2026-13-45") = ${JSON.stringify(parseDisplayDateOLD("2026-13-45"))}`);

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
