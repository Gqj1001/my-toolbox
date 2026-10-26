#!/usr/bin/env node
/**
 * 0030 后的测试账号前置检查：rolea 必须是 Test Owner（或 0030 前的 legacy admin）
 *
 * 背景：0030 会把“除真实 Owner 外的 admin 全部降级”。当前全套测试用 rolea 当管理员；
 * 0030 后如果不处理，所有 admin 测试会红。生产/测试隔离方案：
 *   · 在**测试 Supabase 项目**里执行 `tests/test-owner-grant.sql`，把 rolea 设为 Test Owner；
 *   · 跑完全套立刻执行 `tests/test-owner-revoke.sql`，把 rolea 降回普通 user；
 *   · 本套件先验证 rolea 的 role/admin_scope；不满足就明确报错，避免整套跑一半才红。
 *
 * 不会写任何数据，只读 user_roles 自己那一行。
 */
import { readEnv, readUsers, makeRecorder } from "./_helpers.mjs";

const { record, summary } = makeRecorder();
const { adminEmail, password } = readUsers();
const { SUPABASE_URL, ANON_KEY } = readEnv();

const tokenRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ email: adminEmail, password }),
});
const tok = await tokenRes.json().catch(() => null);
record("（准备）rolea 能登录", !!tok?.access_token);

if (!tok?.access_token || !tok?.user?.id) {
  console.log("\n⚠️  0030 后测试账号前置检查失败：rolea 登录失败。\n");
  process.exit(summary() ? 0 : 1);
}

const r = await fetch(
  `${SUPABASE_URL}/rest/v1/user_roles?select=role,admin_scope,scope_id&user_id=eq.${tok.user.id}`,
  { headers: { apikey: ANON_KEY, Authorization: `Bearer ${tok.access_token}` } },
);
const rows = await r.json().catch(() => []);
const me = Array.isArray(rows) ? rows[0] : null;

record("★0030 后测试前置：rolea 仍是 admin（不是 user）", me?.role === "admin", `role=${me?.role}`);
record(
  "★0030 后测试前置：rolea 是 owner（或 0030 前的 legacy null）——否则请先跑 tests/test-owner-grant.sql",
  me?.role === "admin" && (me?.admin_scope === "owner" || me?.admin_scope == null),
  `admin_scope=${me?.admin_scope}`,
);

if (me?.role !== "admin" || !(me?.admin_scope === "owner" || me?.admin_scope == null)) {
  console.log("\n⚠️  0030 后测试前置检查失败：rolea 不是 Test Owner。");
  console.log("   1) 在【测试库】执行：tests/test-owner-grant.sql");
  console.log("   2) 跑完全套后立刻执行：tests/test-owner-revoke.sql");
  console.log("   生产库不要长期保留 Test Owner。");
  console.log("   （当前没有 service_role / 数据库直连，测试代码无法自动提权。）\n");
}

process.exit(summary() ? 0 : 1);
