/**
 * 阶段3：paper-analysis 接入统一学生 API（`/api/students`）
 *
 * 覆盖四条（每条都对应一个「静默出错」的风险）：
 *   1. **档案往返 + 合并语义**：写 class_name / extra.cls，再用只带 grade 的
 *      POST 覆盖一次 —— cls 必须**还在**（用整行覆盖的写法会把它清掉）。
 *   2. **历史导入幂等**：同一批 items 导入两次，第二次必须 `inserted:0 / skipped:N`，
 *      不能造重复数据。
 *   3. **日期归一化如实报告**：`2026年10月7日` 要落成 `2026-10-07`（阶段3 给
 *      parseDisplayDate 补的分支）；解析不出来的要**数出来**（dateUnparsed），
 *      不能静默丢。
 *   4. **跨账号隔离 + 单条历史删除**：B 账号看不到 A 的数据；`DELETE ?id=`
 *      要真的删掉（且不被 25 秒缓存"复活"）。
 *
 * 跑法：& "<bundled node>" tests\paper-analysis-students.test.mjs
 * ⚠️ 自己起 next start（端口 3000），别和其它真服务套件同时跑。
 */
import { spawnSync } from "node:child_process";
import { readEnv, readUsers, makeRecorder } from "./_helpers.mjs";
import { ensureServer, loginCookie, DEBUG_TOKEN } from "./_students-baseline.mjs";

const BASE = "http://127.0.0.1:3000";
const { record, summary } = makeRecorder();

const STU = "__paper阶段3探针";
const STU_B = "__paper阶段3探针B";

let srv = null;
try {
  srv = await ensureServer();
  record("next start 起来了", true);
  const { adminEmail, userEmail, password } = readUsers();

  // A = 管理员（本测试主账号）；B = 另一个账号，用来验隔离
  const cookieA = await loginCookie(adminEmail, password);
  record("A 账号（管理员）登录成功", !!cookieA);
  const cookieB = await loginCookie(userEmail, password);
  record("B 账号登录成功", !!cookieB);
  if (!cookieA || !cookieB) throw new Error("登录失败，后续无法继续");

  const { SUPABASE_URL, ANON_KEY } = readEnv();
  const tok = await (await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail, password }),
  })).json();
  const H = { apikey: ANON_KEY, Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/json" };

  /** 直连库清干净探针数据（每轮开始/结束都做，保证可重复跑） */
  const purge = async (name) => {
    await fetch(`${SUPABASE_URL}/rest/v1/feedback_history?student_name=eq.${encodeURIComponent(name)}`, { method: "DELETE", headers: H });
    await fetch(`${SUPABASE_URL}/rest/v1/feedback_students?name=eq.${encodeURIComponent(name)}`, { method: "DELETE", headers: H });
  };
  /** 直连库写完之后必须清服务端进程内缓存，否则会读到 25 秒旧值 */
  const clearCaches = () => fetch(`${BASE}/api/debug/clear-caches`, {
    method: "POST", headers: { "x-debug-token": DEBUG_TOKEN, cookie: cookieA },
  }).catch(() => null);

  const api = (cookie) => async (path, init = {}) => {
    const r = await fetch(BASE + path, {
      ...init,
      headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) },
    });
    let body = null;
    try { body = await r.json(); } catch { /* 可能是空体 */ }
    return { status: r.status, body };
  };
  const apiA = api(cookieA);
  const apiB = api(cookieB);

  await purge(STU); await purge(STU_B);

  // ============================================================
  // 1. 档案往返 + 合并语义
  // ============================================================
  console.log("\n=== 1. 档案往返 + 合并语义 ===");
  {
    const w = await apiA("/api/students", {
      method: "POST",
      body: JSON.stringify({
        name: STU, gender: "男", grade: "高三", subject: "数学", teacher: "郭庆杰",
        manager: "李学管", class_name: "3班", attitude: "计算能力弱",
        extra: { cls: "3班" },
      }),
    });
    record("写入档案返回 200 且 ok", w.status === 200 && w.body?.ok === true,
      `status=${w.status} body=${JSON.stringify(w.body)?.slice(0, 140)}`);

    const got = await apiA(`/api/students?name=${encodeURIComponent(STU)}`);
    const s = got.body?.student;
    record("★档案往返：写进去的字段都读得出来",
      s?.grade === "高三" && s?.gender === "男" && s?.class_name === "3班" &&
        s?.manager === "李学管" && s?.attitude === "计算能力弱",
      JSON.stringify({ grade: s?.grade, gender: s?.gender, class_name: s?.class_name,
        manager: s?.manager, attitude: s?.attitude }));
    record("★工具专属字段在 extra 里（extra.cls = 3班）",
      s?.extra && typeof s.extra === "object" && s.extra.cls === "3班",
      `extra=${JSON.stringify(s?.extra)} typeof=${typeof s?.extra}`);

    // 合并语义：只发 grade，别的字段必须原样保留
    const merge = await apiA("/api/students", {
      method: "POST",
      body: JSON.stringify({ name: STU, grade: "高二" }),
    });
    record("合并写入（只发 grade）返回 200", merge.status === 200 && merge.body?.ok === true);
    const got2 = await apiA(`/api/students?name=${encodeURIComponent(STU)}`);
    const s2 = got2.body?.student;
    record("★合并语义：grade 被改成『高二』",
      s2?.grade === "高二", `grade=${JSON.stringify(s2?.grade)}`);
    record("★合并语义：没传的 class_name / extra.cls **没有**被清掉（整行覆盖会清掉）",
      s2?.class_name === "3班" && s2?.extra?.cls === "3班",
      `class_name=${JSON.stringify(s2?.class_name)} extra=${JSON.stringify(s2?.extra)}`);
  }

  // ============================================================
  // 2. 历史导入幂等 + 映射（tool/title/score/full_score）
  // ============================================================
  console.log("\n=== 2. 历史导入幂等 + 字段映射 ===");
  let histId = null;
  {
    const items = [
      { student_name: STU, text: "第一次月考分析正文", date: "2026年10月7日", tool: "paper",
        title: "第一次月考", score: 86, full_score: 150 },
      { student_name: STU, text: "期中分析正文", date: "11月3日", tool: "paper",
        title: "期中考试", score: 102, full_score: 150 },
    ];
    const imp1 = await apiA("/api/students", { method: "POST", body: JSON.stringify({ op: "import", items }) });
    record("首次导入返回 200", imp1.status === 200 && imp1.body?.ok === true,
      `status=${imp1.status} body=${JSON.stringify(imp1.body)}`);
    record("★首次导入 inserted = 2",
      imp1.body?.inserted === 2, `inserted=${imp1.body?.inserted} skipped=${imp1.body?.skipped}`);

    // 幂等：原样再导一次
    const imp2 = await apiA("/api/students", { method: "POST", body: JSON.stringify({ op: "import", items }) });
    record("★幂等：同一批再导一次 → inserted = 0（不造重复数据）",
      imp2.body?.inserted === 0 && imp2.body?.skipped === 2,
      `inserted=${imp2.body?.inserted} skipped=${imp2.body?.skipped}`);

    const hist = await apiA(`/api/students?withHistory=1`);
    const list = hist.body?.history?.[STU] || [];
    record("★历史读回来正好 2 条（幂等之后没有变多）", list.length === 2, `条数=${list.length}`);

    const first = list.find((h) => h.title === "第一次月考");
    record("★字段映射：tool=paper / title=examName / score / full_score 都对",
      first?.tool === "paper" && first?.score === 86 && first?.fullScore === 150,
      JSON.stringify({ tool: first?.tool, title: first?.title, score: first?.score, fullScore: first?.fullScore }));
    record("★日期落成给人看的写法（10月7日），不是 ISO 原串",
      first?.date === "10月7日", `date=${JSON.stringify(first?.date)}`);
    histId = first?.id ?? null;
    record("（准备）拿到一条历史的 id，供后面测单条删除", histId != null, `id=${histId}`);
  }

  // ============================================================
  // 3. 日期归一化：年月日能解析、解析不了的如实数出来
  // ============================================================
  console.log("\n=== 3. 日期归一化（阶段3 新增的『年月日』分支）===");
  {
    const items = [
      { student_name: STU, text: "带年份日期", date: "2026年10月7日", tool: "paper", title: "带年份", score: 90, full_score: 150 },
      { student_name: STU, text: "认不出的日期", date: "周三", tool: "paper", title: "认不出", score: 91, full_score: 150 },
    ];
    const r = await apiA("/api/students", { method: "POST", body: JSON.stringify({ op: "import", items }) });
    record("导入返回 200", r.status === 200 && r.body?.ok === true, `status=${r.status}`);
    record("★解析不出来的条数被如实报出来（dateUnparsed = 1，不静默丢）",
      r.body?.dateUnparsed === 1, `dateUnparsed=${r.body?.dateUnparsed} received=${r.body?.received} accepted=${r.body?.accepted}`);

    // 直连库看 date 列的真实值（接口把它格式化成「10月7日」了，看不到原始 ISO）
    const rows = await (await fetch(
      `${SUPABASE_URL}/rest/v1/feedback_history?student_name=eq.${encodeURIComponent(STU)}&text=in.(%E5%B8%A6%E5%B9%B4%E4%BB%BD%E6%97%A5%E6%9C%9F,%E8%AE%A4%E4%B8%8D%E5%87%BA%E7%9A%84%E6%97%A5%E6%9C%9F)&select=text,date`,
      { headers: H })).json();
    const ymd = rows.find((x) => x.text === "带年份日期");
    const bad = rows.find((x) => x.text === "认不出的日期");
    record("★『2026年10月7日』真的落成 date=2026-10-07（老实现会丢成 null）",
      ymd?.date === "2026-10-07", `库里=${JSON.stringify(ymd?.date)}`);
    record("★认不出的日期落成 null（不报错、但已经数给用户看了）",
      bad?.date === null, `库里=${JSON.stringify(bad?.date)}`);
  }

  // ============================================================
  // 4. 跨账号隔离
  // ============================================================
  console.log("\n=== 4. 跨账号隔离 ===");
  {
    const bList = await apiB("/api/students?withHistory=1");
    const bStu = bList.body?.students?.[STU];
    const bHist = bList.body?.history?.[STU];
    record("★B 账号看不到 A 的档案",
      bStu === undefined, `B 查到=${JSON.stringify(bStu)?.slice(0, 60)}`);
    record("★B 账号看不到 A 的历史",
      bHist === undefined || (Array.isArray(bHist) && bHist.length === 0),
      `B 查到 ${Array.isArray(bHist) ? bHist.length : "undefined"} 条`);
  }

  // ============================================================
  // 5. 删除单条历史（阶段3 给 /api/students 补的 ?id= 分支）
  // ============================================================
  console.log("\n=== 5. 删除单条历史 ===");
  if (histId != null) {
    const before = (await apiA("/api/students?withHistory=1")).body?.history?.[STU]?.length ?? 0;
    const del = await apiA(`/api/students?id=${histId}`, { method: "DELETE" });
    record("DELETE ?id= 返回 200", del.status === 200 && del.body?.ok === true,
      `status=${del.status} body=${JSON.stringify(del.body)}`);
    const after = (await apiA("/api/students?withHistory=1")).body?.history?.[STU]?.length ?? 0;
    record("★删掉的那条真的没了（不是被 25 秒缓存『复活』）",
      after === before - 1, `删前 ${before} 条 → 删后 ${after} 条`);
  } else {
    record("删除单条历史", false, "没拿到 histId，跳过");
  }

  // ============================================================
  // 6. 删除整个档案（连带历史）
  // ============================================================
  console.log("\n=== 6. 删除档案（连带历史）===");
  {
    const del = await apiA(`/api/students?name=${encodeURIComponent(STU)}`, { method: "DELETE" });
    record("DELETE ?name= 返回 200", del.status === 200 && del.body?.ok === true);
    const after = await apiA("/api/students?withHistory=1");
    record("★档案与它的历史都被删干净",
      after.body?.students?.[STU] === undefined &&
        (after.body?.history?.[STU]?.length ?? 0) === 0,
      `students有=${after.body?.students?.[STU] !== undefined} history条数=${after.body?.history?.[STU]?.length ?? 0}`);
  }

  // ============================================================
  // 清理
  // ============================================================
  await purge(STU); await purge(STU_B);
  await clearCaches();
  const left = await (await fetch(
    `${SUPABASE_URL}/rest/v1/feedback_students?name=in.(${encodeURIComponent(STU)},${encodeURIComponent(STU_B)})&select=name`,
    { headers: H })).json();
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
