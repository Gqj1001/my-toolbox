#!/usr/bin/env node
/**
 * Owner 专属 /admin/scopes：页面、表单、RPC 分配/撤销。
 * 需要 0033 已执行 + rolea 临时 Test Owner（跑完由 test-owner-revoke 降级）。
 */
import { readEnv, readUsers, makeRecorder, startServer } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const BASE = "http://127.0.0.1:3000";
const { record, summary } = makeRecorder();
const { SUPABASE_URL, ANON_KEY } = readEnv();
const { adminEmail, userEmail, password } = readUsers();

let srv = null;
try {
  srv = await startServer();
  const tokenFor = async (email) => {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return r.json();
  };
  const admin = await tokenFor(adminEmail);
  const user = await tokenFor(userEmail);
  record("Owner 与普通老师都能登录", !!admin?.access_token && !!user?.access_token);

  const adminCookie = await loginCookie(adminEmail, password);
  const userCookie = await loginCookie(userEmail, password);
  const H = (t) => ({ apikey: ANON_KEY, Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" });

  const page = await fetch(`${BASE}/admin/scopes`, { headers: { cookie: adminCookie } });
  const html = await page.text();
  record("★/admin/scopes 页面 200，含大区/校区/管理者三块表单",
    page.status === 200 && html.includes("大区与权限管理") && html.includes("新建大区") &&
      html.includes("新建校区") && html.includes("管理者分配") && html.includes("保存权限"),
    `status=${page.status}`);

  const adminPage = await fetch(`${BASE}/admin`, { headers: { cookie: adminCookie } });
  const adminHtml = await adminPage.text();
  record("★/admin 页面有「大区与权限管理」入口", adminHtml.includes("大区与权限管理"));

  const regionRes = await fetch(`${SUPABASE_URL}/rest/v1/regions?select=id,name&name=eq.${encodeURIComponent("廊坊大区（三河区域）")}`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${admin.access_token}` } });
  const regions = await regionRes.json().catch(() => []);
  const regionId = regions?.[0]?.id;
  record("（准备）拿到测试大区 ID", !!regionId, regionId);

  const assign = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_set_manager`, {
    method: "POST",
    headers: H(admin),
    body: JSON.stringify({ p_email: userEmail, p_scope: "region", p_scope_id: regionId }),
  });
  record("★Owner 可通过 RPC 把普通老师设为「大区管理员」", assign.status === 204 || assign.status === 200, `HTTP ${assign.status}`);

  const list = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_list_managers`, { method: "POST", headers: H(admin), body: "{}" });
  const managers = await list.json().catch(() => []);
  record("★管理者列表能查到刚设的大区管理员", list.status === 200 && Array.isArray(managers) &&
    managers.some((m) => m.email === userEmail && m.admin_scope === "region"), JSON.stringify(managers).slice(0, 300));

  const deny = await fetch(`${BASE}/admin/scopes`, { headers: { cookie: userCookie }, redirect: "manual" });
  record("★大区管理员打不开 Owner 专属 /admin/scopes（307/403）", deny.status === 307 || deny.status === 403, `HTTP ${deny.status}`);

  const reset = await fetch(`${SUPABASE_URL}/rest/v1/rpc/admin_set_manager`, {
    method: "POST",
    headers: H(admin),
    body: JSON.stringify({ p_email: userEmail, p_scope: "none", p_scope_id: null }),
  });
  record("（收尾）把测试账号恢复为普通老师", reset.status === 204 || reset.status === 200, `HTTP ${reset.status}`);
} finally {
  if (srv) srv.kill();
}
process.exit(summary() ? 0 : 1);
