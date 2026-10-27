#!/usr/bin/env node
/**
 * 批量导入：模板下载 + CSV 导入 + 权限。
 * 需要 0033 已执行 + rolea 临时 Test Owner。
 */
import { readEnv, readUsers, makeRecorder, startServer } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const BASE = "http://127.0.0.1:3000";
const NAME = "__批量导入探针__";
const { record, summary } = makeRecorder();
const { SUPABASE_URL, ANON_KEY } = readEnv();
const { adminEmail, userEmail, password } = readUsers();

let srv = null;
try {
  srv = await startServer();
  const adminCookie = await loginCookie(adminEmail, password);
  const userCookie = await loginCookie(userEmail, password);

  const tpl = await fetch(`${BASE}/api/import/template`, { headers: { cookie: adminCookie } });
  record("★模板下载 200 且是 xlsx", tpl.status === 200 && (tpl.headers.get("content-type") ?? "").includes("spreadsheetml"), `HTTP ${tpl.status}`);

  const csv = `学生姓名,年级,学校,学管师,科目,老师\n${NAME},高三,三河一中,李学管,数学,郭老师\n`;
  const fd = new FormData();
  fd.append("file", new File([csv], "students.csv", { type: "text/csv" }));
  const imp = await fetch(`${BASE}/api/import/students`, { method: "POST", body: fd, headers: { cookie: adminCookie } });
  const body = await imp.json().catch(() => null);
  record("★CSV 导入成功 1 条", imp.status === 200 && body?.success === 1 && body?.failed === 0, JSON.stringify(body));

  const list = await fetch(`${BASE}/api/students?name=${encodeURIComponent(NAME)}`, { headers: { cookie: adminCookie } });
  const listBody = await list.json().catch(() => null);
  record("★导入后的学生能在档案接口读到", list.status === 200 && !!listBody?.student, JSON.stringify(listBody?.student ?? null));

  const deny = await fetch(`${BASE}/api/import/students`, { method: "POST", body: fd, headers: { cookie: userCookie } });
  record("★普通老师不能批量导入（403）", deny.status === 403, `HTTP ${deny.status}`);

  await fetch(`${BASE}/api/students?name=${encodeURIComponent(NAME)}`, { method: "DELETE", headers: { cookie: adminCookie } });
  record("（收尾）探针已清理", true);
} finally {
  if (srv) srv.kill();
}
process.exit(summary() ? 0 : 1);
