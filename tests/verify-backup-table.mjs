// 验证备份表：存在性 + 策略 + 真实写入/读取/删除（insert 带 returning 是最容易踩坑的地方）
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = readFileSync("D:/my-website/my-toolbox/.env.local", "utf8").split(/\r?\n/);
const url = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim();
const key = env.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim();
const info = JSON.parse(readFileSync("D:/my-website/my-toolbox/.test-users.json", "utf8"));
const db = createClient(url, key, { auth: { persistSession: false } });
await db.auth.signInWithPassword({ email: info.users.find((u) => u.email.startsWith("rolea-")).email, password: info.password });

const T = "feedback_section_candidates_backup";
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
};

// 1. 存在性
const probe = await db.from(T).select("backup_id").limit(1);
record("备份表存在", !probe.error, probe.error ? `${probe.error.code} ${probe.error.message}` : "");

// 2. 行数应 0
const { count } = await db.from(T).select("*", { count: "exact", head: true });
record("初始备份行数为 0", count === 0, `${count}`);

// 3. 取一个真实的候选 id 用于测试
const { data: cand } = await db.from("feedback_section_candidates")
  .select("id, batch_id, stage, subject, version, book_name, section_name, keywords, status, note, reviewed_by, reviewed_at, promoted_at")
  .limit(1).maybeSingle();

// 4. 真实写入（重点：insert + select(returning)）
const TAG = `selftest-${Date.now()}`;
const ins = await db.from(T).insert({
  backup_tag: TAG, candidate_id: cand?.id ?? 1, batch_id: cand?.batch_id ?? "test",
  stage: cand?.stage ?? "senior", subject: cand?.subject ?? "math", version: cand?.version ?? "v",
  book_name: cand?.book_name ?? "b", section_name: cand?.section_name ?? "s",
  keywords: cand?.keywords ?? [], status: cand?.status ?? "pending", note: cand?.note ?? null,
  reviewed_by: cand?.reviewed_by ?? null, reviewed_at: cand?.reviewed_at ?? null, promoted_at: cand?.promoted_at ?? null,
}).select("backup_id, backup_tag");
record("写入备份（insert + returning）成功", !ins.error && (ins.data ?? []).length === 1,
  ins.error ? `${ins.error.code} ${ins.error.message}` : `backup_id=${ins.data?.[0]?.backup_id}`);

// 5. 读取
if (!ins.error && ins.data?.length) {
  const rd = await db.from(T).select("section_name, keywords").eq("backup_tag", TAG);
  record("能读回备份行", !rd.error && (rd.data ?? []).length === 1, rd.error?.message ?? `1 行`);
}

// 6. 模拟恢复语句能跑（用 RPC 不可行，这里只验证 update 权限）
if (!ins.error && ins.data?.length) {
  const up = await db.from(T).update({ note: "selftest" }).eq("backup_tag", TAG).select("backup_id");
  record("能更新备份行", !up.error, up.error ? `${up.error.code}` : `影响 ${up.data?.length} 行`);
}

// 7. 清理测试数据
const del = await db.from(T).delete().eq("backup_tag", TAG).select("backup_id");
record("能删除备份行", !del.error && (del.data ?? []).length === 1, del.error ? `${del.error.code}` : `删除 ${del.data?.length} 行`);

// 8. 清理后应恢复为 0
const { count: c2 } = await db.from(T).select("*", { count: "exact", head: true });
record("清理后回到 0 行", c2 === 0, `${c2}`);

// 9. 普通用户不能写（RLS 第二道防线）
const userEmail = info.users.find((u) => u.email.startsWith("roleb-")).email;
const ub = createClient(url, key, { auth: { persistSession: false } });
await ub.auth.signInWithPassword({ email: userEmail, password: info.password });
const w = await ub.from(T).insert({ backup_tag: "hack", candidate_id: 1 }).select("backup_id");
record("普通用户写入被 RLS 拒绝", Boolean(w.error), w.error ? w.error.code : "⚠️ 竟然成功");

const passed = results.filter((r) => r.pass).length;
console.log(`\n=== ${passed}/${results.length} 通过 ===`);
process.exit(passed === results.length ? 0 : 1);
