#!/usr/bin/env node
/**
 * 后台用户列表必须显示老师自己填的姓名/校区（2026-10 线上 Bug）
 *
 * 根因：`user_profiles` 的 RLS 只允许本人读（0021 的设计），后台却用管理员会话
 * 直接 `.from("user_profiles").select(...)`，所以只能读到管理员自己那一行，
 * 别的老师永远显示「资料未填」。
 *
 * 修法：迁移 `0026_admin_list_profiles.sql` 提供 SECURITY DEFINER 函数
 * `admin_list_profiles()`（内部校验 is_admin，只返回四列）；后台改调它。
 *
 * ⚠️ 本套件**要求 0026 已执行**。没执行时不会假装通过 —— 会明确失败并提示
 *    去 Supabase SQL Editor 跑哪份文件。
 *
 * 跑法：node tests/admin-profiles.test.mjs（自己起 next start）
 */
import { readEnv, readUsers, makeRecorder, startServer } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const BASE = "http://127.0.0.1:3000";
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
  record("管理员与普通老师都登录成功", !!adminTok?.access_token && !!userTok?.access_token);

  const H = (tok) => ({
    apikey: ANON_KEY,
    Authorization: `Bearer ${tok.access_token}`,
    "Content-Type": "application/json",
  });

  // ⚠️ `user_profiles` 没有 delete 策略（0021 只给了 select/insert/update），
  //    所以清理只能 PATCH 成空串；不能 DELETE（会被 RLS 静默挡掉，探针会留在账号上）。
  const NAME = "__后台资料探针__";
  const CAMPUS = "__探针校区__";
  const upsert = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?on_conflict=user_id`, {
    method: "POST",
    headers: { ...H(userTok), Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      user_id: userTok.user.id,
      teacher_name: NAME,
      subject: "math",
      campus: CAMPUS,
      sig_teacher: "",
      updated_at: new Date().toISOString(),
    }),
  });
  record("（准备）给普通老师写入姓名/校区资料",
    (upsert.status === 200 || upsert.status === 201), `status=${upsert.status}`);

  // 0026 在不在：直接问 RPC（缺函数时 PostgREST 返回 404 / PGRST202）
  const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_list_profiles`, {
    method: "POST",
    headers: H(adminTok),
    body: "{}",
  });
  const rpcBody = await rpc.text().catch(() => "");
  record("★迁移 0026 已执行：admin_list_profiles() 可调用（没执行请先去 SQL Editor 跑）",
    rpc.status === 200,
    `HTTP ${rpc.status} ${rpcBody.slice(0, 160)}`);

  if (rpc.status === 200) {
    const cookie = await loginCookie(adminEmail, password);
    const page = await fetch(`${BASE}/admin`, { headers: { cookie } });
    const html = await page.text();
    record("★后台页面 200 且显示老师真实姓名（不再「资料未填」）",
      page.status === 200 && html.includes(NAME) && !new RegExp(`${userEmail}[^]{0,80}资料未填`).test(html),
      `status=${page.status} 含姓名=${html.includes(NAME)}`);
    record("★后台页面显示老师真实校区",
      html.includes(CAMPUS), `含校区=${html.includes(CAMPUS)}`);
  }

  // 清理：PATCH 成空串（没有 delete 策略）；profile.test 的正常态就是“表在但没填”
  await fetch(`${SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${userTok.user.id}`, {
    method: "PATCH",
    headers: H(userTok),
    body: JSON.stringify({
      teacher_name: "",
      subject: "",
      campus: "",
      sig_teacher: "",
      updated_at: new Date().toISOString(),
    }),
  });
} finally {
  if (srv) srv.kill();
}
process.exit(summary() ? 0 : 1);
