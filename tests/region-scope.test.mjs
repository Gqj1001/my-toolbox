#!/usr/bin/env node
/**
 * Phase 1 权限：大区管理员只读范围测试（要求 0031 已执行）
 *
 * 覆盖：
 *   · 老师（roleb）仍只看到自己创建的学生；
 *   · 把 roleb 临时设为“廊坊大区 / 燕郊中学校区”的大区管理员后：
 *       - 后台 RPC 只返回本大区学生（看不到无大区/其它大区学生）；
 *       - `/admin/archives` 只显示本大区，且没有“归属纠正”表单（只读）；
 *       - 不能调用 `admin_set_student_campus`（只 Owner 可改）；
 *   · legacy Owner（rolea，0030 前）仍能看到全部；
 *   · 跑完恢复 roleb 为普通 user、清空测试资料/学生。
 *
 * 跑法：node tests/region-scope.test.mjs（自己起 next start）
 */
import { readEnv, readUsers, makeRecorder, startServer } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const BASE = "http://127.0.0.1:3000";
const REGION_NAME = "廊坊大区（三河区域）";
const CAMPUS_NAME = "燕郊中学校区";
const A_NAME = "__区域探针A__";
const B_NAME = "__区域探针B__";
const { record, summary } = makeRecorder();
const { adminEmail, userEmail, password } = readUsers();
const { SUPABASE_URL, ANON_KEY } = readEnv();

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
  record("Owner(rolea) 与老师(roleb) 都登录成功", !!adminTok?.access_token && !!userTok?.access_token);

  const H = (tok) => ({
    apikey: ANON_KEY,
    Authorization: `Bearer ${tok.access_token}`,
    "Content-Type": "application/json",
  });
  const rest = async (tok, path, init = {}) => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...init, headers: { ...H(tok), ...(init.headers ?? {}) } });
    const text = await r.text().catch(() => "");
    let body = null;
    try { body = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, body, text };
  };

  const region = await rest(adminTok, `/regions?select=id,name&name=eq.${encodeURIComponent(REGION_NAME)}`);
  const campus = await rest(adminTok, `/campuses?select=id,name,region_id&region_id=eq.${region.body?.[0]?.id}&name=eq.${encodeURIComponent(CAMPUS_NAME)}`);
  const regionId = region.body?.[0]?.id;
  const campusId = campus.body?.[0]?.id;
  record("（准备）找到廊坊大区 / 燕郊中学校区真实 ID", !!regionId && !!campusId, JSON.stringify({ regionId, campusId }));

  // 清理旧探针
  const adminCookie = await loginCookie(adminEmail, password);
  const userCookie = await loginCookie(userEmail, password);
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

  // rolea 不属任何大区（Owner 仍看全部）；roleb 属廊坊大区/燕郊校区
  await rest(adminTok, `/user_profiles?user_id=eq.${adminTok.user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ teacher_name: "__Owner探针__", campus: "", region_id: null, campus_id: null, sig_teacher: "" }),
  });
  const setB = await rest(userTok, `/user_profiles?user_id=eq.${userTok.user.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      teacher_name: "__区域老师__", subject: "math", campus: CAMPUS_NAME,
      region_id: regionId, campus_id: campusId, sig_teacher: "",
    }),
  });
  record("（准备）roleb 资料归属廊坊大区/燕郊校区", setB.status === 204 || setB.status === 200, `HTTP ${setB.status}`);

  const mkA = await api(adminCookie, "/api/students", {
    method: "POST",
    body: JSON.stringify({ name: A_NAME, grade: "高三", campus: "三河一中", manager: "李学管" }),
  });
  const mkB = await api(userCookie, "/api/students", {
    method: "POST",
    body: JSON.stringify({ name: B_NAME, grade: "高二", campus: "大厂一中", manager: "王学管" }),
  });
  record("（准备）Owner 建 A、老师建 B", mkA.status === 200 && mkB.status === 200, `${mkA.status}/${mkB.status}`);

  // 各写一条历史，供 RLS 历史策略测试
  await api(adminCookie, "/api/students", {
    method: "POST",
    body: JSON.stringify({ op: "import", items: [{ student_name: A_NAME, text: "【课堂内容】A 的课", date: "2026-10-20", tool: "feedback", title: "A 反馈" }] }),
  });
  await api(userCookie, "/api/students", {
    method: "POST",
    body: JSON.stringify({ op: "import", items: [{ student_name: B_NAME, text: "【课堂内容】B 的课", date: "2026-10-21", tool: "feedback", title: "B 反馈" }] }),
  });

  // 触发器应自动写入 B 的快照；A 无大区（Owner 直读现在只看自己，所以分开查）
  const snapA = await rest(adminTok, `/feedback_students?select=id,name,region_id,campus_id,created_at&name=eq.${encodeURIComponent(A_NAME)}`);
  const snapB = await rest(userTok, `/feedback_students?select=id,name,region_id,campus_id,created_at&name=eq.${encodeURIComponent(B_NAME)}`);
  const bRow = snapB.body?.[0];
  const aRow = snapA.body?.[0];
  record("★学生建档快照：B 自动带上 region_id/campus_id/created_at，A 无大区",
    bRow?.region_id === regionId && bRow?.campus_id === campusId && !!bRow?.created_at &&
      snapA.body?.[0]?.region_id == null,
    JSON.stringify({ A: snapA.body, B: snapB.body }));

  // 仍是普通老师时：RLS 只能看自己的 B
  const bBefore = await rest(userTok, `/feedback_students?select=name&name=in.(${encodeURIComponent(A_NAME)},${encodeURIComponent(B_NAME)})`);
  record("★普通老师 RLS：只看得到自己创建的 B，看不到 A",
    Array.isArray(bBefore.body) && bBefore.body.some((r) => r.name === B_NAME) && !bBefore.body.some((r) => r.name === A_NAME),
    JSON.stringify(bBefore.body));

  // 临时把 roleb 设为大区管理员（0030 未跑；用 rolea legacy Owner 授权）
  const promote = await rest(adminTok, `/user_roles?user_id=eq.${userTok.user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ role: "admin", admin_scope: "region", scope_id: regionId, campus_id: null }),
  });
  record("（准备）把 roleb 临时设为大区管理员（scope=廊坊）", promote.status === 204 || promote.status === 200, `HTTP ${promote.status}`);

  // 角色/中间件各有 30 秒进程缓存；重启一次 next start，确保读到新 scope（cookie/token 不变）
  srv.kill();
  srv = await startServer();

  const rlsStudents = await rest(userTok, `/feedback_students?select=name&name=in.(${encodeURIComponent(A_NAME)},${encodeURIComponent(B_NAME)})`);
  record("★RLS（学生表）：大区管理员直接查也只返回本大区 B",
    Array.isArray(rlsStudents.body) && rlsStudents.body.some((r) => r.name === B_NAME) && !rlsStudents.body.some((r) => r.name === A_NAME),
    JSON.stringify(rlsStudents.body));

  const rlsHistory = await rest(userTok, `/feedback_history?select=student_name,text&student_name=in.(${encodeURIComponent(A_NAME)},${encodeURIComponent(B_NAME)})`);
  record("★RLS（历史表）：大区管理员直接查也只返回本大区 B 的历史",
    Array.isArray(rlsHistory.body) && rlsHistory.body.some((r) => r.student_name === B_NAME) && !rlsHistory.body.some((r) => r.student_name === A_NAME),
    JSON.stringify(rlsHistory.body));

  // RPC / 页面按大区过滤
  const rpc = await rest(userTok, "/rpc/admin_list_all_students", {
    method: "POST",
    body: JSON.stringify({ p_search: "__区域探针" }),
  });
  const rows = Array.isArray(rpc.body) ? rpc.body : [];
  record("★大区管理员 RPC：只返回本大区 B，不返回无大区 A",
    rpc.status === 200 && rows.some((r) => r.name === B_NAME) && !rows.some((r) => r.name === A_NAME),
    `HTTP ${rpc.status} ${JSON.stringify(rows.map((r) => r.name))}`);

  const stats = await rest(userTok, "/rpc/admin_archive_stats", { method: "POST", body: "{}" });
  record("★大区管理员大盘可读（计数不含 A）",
    stats.status === 200 && Number(stats.body?.totalStudents) >= 1,
    `HTTP ${stats.status} ${JSON.stringify(stats.body).slice(0, 160)}`);

  const page = await fetch(`${BASE}/admin/archives`, { headers: { cookie: userCookie } });
  const html = await page.text();
  record("★大区管理员页面：显示 B、不显示 A，标题为「本大区档案总览」",
    page.status === 200 && html.includes(B_NAME) && !html.includes(A_NAME) &&
      html.includes("本大区") && html.includes("档案总览"),
    `status=${page.status} B=${html.includes(B_NAME)} A=${html.includes(A_NAME)} 本大区=${html.includes("本大区")}`);
  record("★大区管理员页面：归属纠正列显示「只读」（没有保存表单）",
    html.includes("只读") && !html.includes("纠正机构校区"),
    "只读列");
  record("★大区管理员顶栏不显示 /admin（只显示「档案总览」）",
    !html.includes("管理后台") && html.includes("档案总览"),
    "顶栏");

  const detailB = await fetch(`${BASE}/admin/archives/${bRow?.id}`, { headers: { cookie: userCookie } });
  const detailBHtml = await detailB.text();
  record("★大区管理员能打开本区学生详情（只读）",
    detailB.status === 200 && detailBHtml.includes(B_NAME) && detailBHtml.includes("只读"),
    `status=${detailB.status}`);

  const detailA = await fetch(`${BASE}/admin/archives/${aRow?.id}`, { headers: { cookie: userCookie } });
  const detailAHtml = await detailA.text();
  record("★大区管理员打不开外区学生详情（403 / 不在范围）",
    !detailAHtml.includes(A_NAME) && (detailA.status === 403 || detailAHtml.includes("不在你的查看范围")),
    `status=${detailA.status}`);

  const ownerRpc = await rest(adminTok, "/rpc/admin_list_all_students", {
    method: "POST",
    body: JSON.stringify({ p_search: "__区域探针" }),
  });
  const ownerRows = Array.isArray(ownerRpc.body) ? ownerRpc.body : [];
  record("★legacy Owner 仍能看到 A + B（0030 前兼容）",
    ownerRpc.status === 200 && ownerRows.some((r) => r.name === A_NAME) && ownerRows.some((r) => r.name === B_NAME),
    JSON.stringify(ownerRows.map((r) => r.name)));

  const deny = await rest(userTok, "/rpc/admin_set_student_campus", {
    method: "POST",
    body: JSON.stringify({ p_student_id: bRow?.id ?? 0, p_campus: "大厂校区" }),
  });
  record("★大区管理员不能改学生归属（只 Owner；函数返回 403/42501）",
    deny.status === 403, `HTTP ${deny.status} ${deny.text.slice(0, 120)}`);

  // 恢复
  await rest(adminTok, `/user_roles?user_id=eq.${userTok.user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ role: "user", admin_scope: null, scope_id: null, campus_id: null }),
  });
  await rest(userTok, `/user_profiles?user_id=eq.${userTok.user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ teacher_name: "", subject: "", campus: "", region_id: null, campus_id: null, sig_teacher: "" }),
  });
  await rest(adminTok, `/user_profiles?user_id=eq.${adminTok.user.id}`, {
    method: "PATCH",
    body: JSON.stringify({ teacher_name: "", subject: "", campus: "", region_id: null, campus_id: null, sig_teacher: "" }),
  });
  await api(adminCookie, `/api/students?name=${encodeURIComponent(A_NAME)}`, { method: "DELETE" });
  await api(adminCookie, `/api/students?name=${encodeURIComponent(B_NAME)}`, { method: "DELETE" });
  record("（收尾）roleb 已恢复普通 user，探针档案/资料已清理", true, "已恢复");
} finally {
  if (srv) srv.kill();
}
process.exit(summary() ? 0 : 1);
