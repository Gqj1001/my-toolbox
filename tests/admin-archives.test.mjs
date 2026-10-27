#!/usr/bin/env node
/**
 * 全机构档案总览（A2）测试
 *
 * 要求：迁移 `0027_admin_archives_a2.sql` 已执行。
 * 没执行时本套件会明确失败并提示去 SQL Editor 跑哪份文件。
 *
 * 覆盖：
 *   · 管理员 RPC 能跨老师看到档案（普通老师只能看自己的）；
 *   · 后台 `/admin/archives` 页面显示所有老师的学生、姓名、机构校区；
 *   · 搜索 / 按机构校区 / 按老师筛选；
 *   · 历史归属默认按“老师当前校区”推断；
 *   · 后台手动纠正某个学生的机构校区标签（只改标签，不改正文），可恢复。
 *
 * 跑法：node tests/admin-archives.test.mjs（自己起 next start）
 */
import { readEnv, readUsers, makeRecorder, startServer } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const BASE = "http://127.0.0.1:3000";
const { record, summary } = makeRecorder();
const { adminEmail, userEmail, password } = readUsers();
const { SUPABASE_URL, ANON_KEY } = readEnv();

const A_NAME = "__总览探针A__";
const B_NAME = "__总览探针B__";
const A_TEACHER = "总览老师A";
const B_TEACHER = "总览老师B";
const A_CAMPUS = "燕郊校区";
const B_CAMPUS = "大厂校区";

let srv = null;
try {
  srv = await startServer();
  record("next start 起来了", true);

  const tokenFor = async (email) => {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return r.json();
  };
  const adminTok = await tokenFor(adminEmail);
  const userTok = await tokenFor(userEmail);
  record("管理员与普通老师都登录成功", !!adminTok?.access_token && !!userTok?.access_token);

  const H = (tok) => ({
    apikey: ANON_KEY,
    Authorization: `Bearer ${tok.access_token}`,
    "Content-Type": "application/json",
  });

  // 两位老师各自的机构校区（跑完恢复为空）
  const setProfile = async (tok, name, campus) => {
    return fetch(`${SUPABASE_URL}/rest/v1/user_profiles?on_conflict=user_id`, {
      method: "POST",
      headers: { ...H(tok), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        user_id: tok.user.id,
        teacher_name: name,
        subject: "math",
        campus,
        sig_teacher: "",
        updated_at: new Date().toISOString(),
      }),
    });
  };
  const pA = await setProfile(adminTok, A_TEACHER, A_CAMPUS);
  const pB = await setProfile(userTok, B_TEACHER, B_CAMPUS);
  record("（准备）两位老师填好姓名/机构校区", pA.ok && pB.ok, `${pA.status}/${pB.status}`);

  const adminCookie = await loginCookie(adminEmail, password);
  const api = async (cookie, path, init = {}) => {
    const r = await fetch(BASE + path, {
      ...init,
      headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) },
    });
    const text = await r.text().catch(() => "");
    let body = null;
    try { body = JSON.parse(text); } catch { /* HTML */ }
    return { status: r.status, body, text };
  };

  await api(adminCookie, `/api/students?name=${encodeURIComponent(A_NAME)}`, { method: "DELETE" });
  await api(adminCookie, `/api/students?name=${encodeURIComponent(B_NAME)}`, { method: "DELETE" });
  const mkA = await api(adminCookie, "/api/students", {
    method: "POST",
    body: JSON.stringify({ name: A_NAME, grade: "高三", campus: "三河一中", manager: "李学管" }),
  });
  // B 由普通老师创建（用 B 自己的 cookie 才符合真实归属）
  const bCookie = await loginCookie(userEmail, password);
  const mkB = await api(bCookie, "/api/students", {
    method: "POST",
    body: JSON.stringify({ name: B_NAME, grade: "高二", campus: "大厂一中", manager: "王学管" }),
  });
  record("（准备）两位老师各建一份档案", mkA.status === 200 && mkB.status === 200,
    `${mkA.status}/${mkB.status}`);

  // A 造一条 10 月的历史，供“月份下钻”与大盘趋势使用
  const mkHist = await api(adminCookie, "/api/students", {
    method: "POST",
    body: JSON.stringify({
      op: "import",
      items: [{
        student_name: A_NAME,
        text: "【课堂内容】总览测试课\n【主要失分点】函数单调性。",
        date: "2026-10-15",
        tool: "feedback",
        title: "总览测试反馈",
      }],
    }),
  });
  record("（准备）给 A 造一条 10 月反馈（月份下钻/趋势用）", mkHist.status === 200, JSON.stringify(mkHist.body));

  // 管理员 RPC：跨老师可见
  const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_list_all_students`, {
    method: "POST",
    headers: H(adminTok),
    body: JSON.stringify({ p_search: "__总览探针" }),
  });
  const rpcRows = await rpc.json().catch(() => []);
  record("★迁移 0027 已执行：admin_list_all_students() 可调用（没执行请先去 SQL Editor 跑）",
    rpc.status === 200, `HTTP ${rpc.status} ${JSON.stringify(rpcRows).slice(0, 160)}`);

  let aId = 0;
  if (rpc.status === 200 && Array.isArray(rpcRows)) {
    const a = rpcRows.find((r) => r.name === A_NAME);
    const b = rpcRows.find((r) => r.name === B_NAME);
    aId = Number(a?.id ?? 0);
    record("★管理员 RPC 跨老师看到两份档案（普通老师 RLS 只让自己看自己的）",
      !!a && !!b, JSON.stringify(rpcRows.map((r) => r.name)));
    record("★机构校区默认按创建老师当前校区推断（A→燕郊 / B→大厂）",
      a?.institution_campus === A_CAMPUS && b?.institution_campus === B_CAMPUS,
      JSON.stringify({ a: a?.institution_campus, b: b?.institution_campus }));
    record("★总览返回的字段够用（学生/年级/学校/学管师/老师/校区/邮箱）",
      a?.grade === "高三" && a?.school === "三河一中" && a?.manager === "李学管" &&
        a?.teacher_name === A_TEACHER && !!a?.owner_email,
      JSON.stringify(a));
  } else {
    record("（后续页面/筛选断言）跳过：函数不存在", true, "见上面迁移提示");
  }

  const statsRpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_archive_stats`, {
    method: "POST",
    headers: H(adminTok),
    body: "{}",
  });
  const stats = await statsRpc.json().catch(() => null);
  record("★迁移 0028 已执行：admin_archive_stats() 可调用（大盘 KPI/图表）",
    statsRpc.status === 200 && stats && Number(stats.totalStudents) >= 2,
    `HTTP ${statsRpc.status} ${JSON.stringify(stats).slice(0, 200)}`);

  // 页面 + 筛选
  const page = await fetch(`${BASE}/admin/archives`, { headers: { cookie: adminCookie } });
  const html = await page.text();
  record("★/admin/archives 页面 200，且能看到两位老师的学生",
    page.status === 200 && html.includes(A_NAME) && html.includes(B_NAME),
    `status=${page.status} A=${html.includes(A_NAME)} B=${html.includes(B_NAME)}`);
  record("★页面显示老师姓名与机构校区",
    html.includes(A_TEACHER) && html.includes(B_TEACHER) &&
      html.includes(A_CAMPUS) && html.includes(B_CAMPUS),
    "含老师/校区");
  record("★机构数据大盘：四张 KPI 卡片都在",
    html.includes("总学员数") && html.includes("本月新增学员") &&
      html.includes("本月消耗课时") && html.includes("进行中方案"),
    "KPI 文案");
  record("★机构数据大盘：两张图（校区饼图 + 提分趋势折线）都渲染",
    html.includes("各校区学员分布饼图") && html.includes("整体学情提分趋势折线图"),
    "图表 aria-label");
  record("★列表高度：外层按视口高度自适应，表格有独立内部滚动（max-h + overflow）",
    html.includes("h-[calc(100dvh-64px)]") && html.includes("max-h-[60vh]") &&
      html.includes("sticky top-0") && html.includes("overflow-auto"),
    "高度/滚动类");
  record("★学生姓名是可点击链接，指向学生详情",
    html.includes(`/admin/archives/${aId}`), `id=${aId}`);

  const detailPage = await fetch(`${BASE}/admin/archives/${aId}`, { headers: { cookie: adminCookie } });
  const detailHtml = await detailPage.text();
  record("★学生详情页 200：基础信息 + 学情分析 + 历史记录 + 只读",
    detailPage.status === 200 &&
      detailHtml.includes(A_NAME) &&
      detailHtml.includes("基础信息") &&
      detailHtml.includes("学情分析") &&
      detailHtml.includes("历史记录") &&
      detailHtml.includes("只读"),
    `status=${detailPage.status}`);

  const bySearch = await (await fetch(`${BASE}/admin/archives?q=${encodeURIComponent("总览探针A")}`, { headers: { cookie: adminCookie } })).text();
  record("★搜索能过滤：搜 A 只出现 A，不出现 B",
    bySearch.includes(A_NAME) && !bySearch.includes(B_NAME), "q=总览探针A");

  const byCampus = await (await fetch(`${BASE}/admin/archives?campus=${encodeURIComponent(B_CAMPUS)}`, { headers: { cookie: adminCookie } })).text();
  record("★按机构校区筛选：大厂只出现 B，不出现 A",
    byCampus.includes(B_NAME) && !byCampus.includes(A_NAME), "campus=大厂校区");

  const byTeacher = await (await fetch(`${BASE}/admin/archives?teacher=${encodeURIComponent(A_TEACHER)}`, { headers: { cookie: adminCookie } })).text();
  record("★按老师筛选：A 老师只出现 A，不出现 B",
    byTeacher.includes(A_NAME) && !byTeacher.includes(B_NAME), "teacher=总览老师A");

  const byMonth = await (await fetch(`${BASE}/admin/archives?month=2026-10`, { headers: { cookie: adminCookie } })).text();
  record("★按月份下钻：2026-10 只出现本月有记录的 A，不出现无记录的 B",
    byMonth.includes(A_NAME) && !byMonth.includes(B_NAME), "month=2026-10");

  // 手动纠正归属（只改 extra.institutionCampus）
  if (rpc.status === 200 && Array.isArray(rpcRows)) {
    const a = rpcRows.find((r) => r.name === A_NAME);
    const set = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_set_student_campus`, {
      method: "POST",
      headers: H(adminTok),
      body: JSON.stringify({ p_student_id: a.id, p_campus: B_CAMPUS }),
    });
    record("★后台手动纠正归属：A 的机构校区改成大厂", set.status === 200 || set.status === 204, `HTTP ${set.status}`);
    const corrected = await (await fetch(`${BASE}/admin/archives?campus=${encodeURIComponent(B_CAMPUS)}`, { headers: { cookie: adminCookie } })).text();
    record("★纠正后按大厂筛选能看到 A（归属标签生效）", corrected.includes(A_NAME), "campus=大厂校区");
    record("★页面标出这是“手动”纠正，不是老师推断",
      corrected.includes("（手动）"), "含（手动）");

    await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_set_student_campus`, {
      method: "POST",
      headers: H(adminTok),
      body: JSON.stringify({ p_student_id: a.id, p_campus: "" }),
    });
    const restored = await (await fetch(`${BASE}/admin/archives?campus=${encodeURIComponent(A_CAMPUS)}`, { headers: { cookie: adminCookie } })).text();
    record("★清空纠正后恢复按老师校区推断（A 回到燕郊）", restored.includes(A_NAME), "campus=燕郊校区");
  }

  // 清理
  await api(adminCookie, `/api/students?name=${encodeURIComponent(A_NAME)}`, { method: "DELETE" });
  await api(bCookie, `/api/students?name=${encodeURIComponent(B_NAME)}`, { method: "DELETE" });
  for (const tok of [adminTok, userTok]) {
    await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${tok.user.id}`, {
      method: "PATCH",
      headers: H(tok),
      body: JSON.stringify({ teacher_name: "", subject: "", campus: "", sig_teacher: "" }),
    });
  }
  record("（收尾）探针档案与老师资料已清理", true, "已清空");
} finally {
  if (srv) srv.kill();
}
process.exit(summary() ? 0 : 1);
