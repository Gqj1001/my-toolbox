#!/usr/bin/env node
/**
 * `readRoleRow()` 的纯函数测试（2026-10 线上 Bug 的防回归）
 *
 * 背景：管理员刷新/重新登录后进不去 `/admin`。根因是 `user_roles` 查询失败
 * 被吞成 `null`，又被 30 秒进程缓存记住 ⇒ 管理员被当成普通用户锁 30 秒。
 * 这里钉住三条契约：
 *   1. 查询报错 → **抛异常**（调用方因此不会把它写缓存）；
 *   2. 查询成功但没行 → 返回 `null`（这是合法的“没有角色”，可以缓存）；
 *   3. 瞬时失败会重试一次（默认），第二次成功就正常返回。
 *
 * 跑法：node tests/role-read.test.mjs（不需要服务、不连库）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeRecorder } from "./_helpers.mjs";

process.removeAllListeners("warning");
process.on("warning", () => { /* 静音 type stripping 警告 */ });

const { readRoleRow } = await import("../src/lib/role-read.ts");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { record, summary } = makeRecorder();

/* 1. 查询报错必须抛，不能返回 null */
{
  let calls = 0;
  let thrown = null;
  try {
    await readRoleRow(async () => {
      calls++;
      return { data: null, error: { code: "PGRST500", message: "upstream down" } };
    }, 0);
  } catch (e) {
    thrown = e;
  }
  record("★查询报错 → 抛异常（调用方因此不会把 null 写缓存）",
    thrown instanceof Error && /upstream down/.test(thrown.message) && calls === 1,
    `calls=${calls} error=${String(thrown)}`);
}

/* 2. 查询成功但确实没有行 → 返回 null（可以缓存） */
{
  const row = await readRoleRow(async () => ({ data: null, error: null }), 0);
  record("★查询成功但没行 → 返回 null（合法的“没有角色”，可以缓存）",
    row === null, String(row));
}

/* 3. 成功读到行 → 原样返回 */
{
  const row = await readRoleRow(async () => ({ data: { role: "admin", status: "active" }, error: null }), 0);
  record("成功读到角色 → 原样返回",
    row?.role === "admin" && row?.status === "active", JSON.stringify(row));
}

/* 4. 瞬时失败重试一次后成功 */
{
  let calls = 0;
  const row = await readRoleRow(async () => {
    calls++;
    if (calls === 1) return { data: null, error: { message: "transient" } };
    return { data: { role: "admin", status: "active" }, error: null };
  });
  record("★瞬时失败重试一次：第 2 次成功即返回（不再把管理员锁 30 秒）",
    calls === 2 && row?.role === "admin", `calls=${calls} row=${JSON.stringify(row)}`);
}

/* 5. 一直失败 → 重试完仍抛（不会静默变成 null） */
{
  let calls = 0;
  let thrown = null;
  try {
    await readRoleRow(async () => {
      calls++;
      return { data: null, error: { message: "always down" } };
    }, 1);
  } catch (e) {
    thrown = e;
  }
  record("★一直失败 → 重试后仍抛（不会静默变成 null）",
    thrown instanceof Error && calls === 2, `calls=${calls} error=${String(thrown)}`);
}

/* 6. 源码契约：两个调用点都必须走 readRoleRow，不能再裸查后吞 error */
{
  const viewer = readFileSync(join(ROOT, "src/lib/viewer.ts"), "utf8");
  const proxy = readFileSync(join(ROOT, "src/proxy.ts"), "utf8");
  record("★契约：页面侧（viewer）走 readRoleRow，且 catch 后不写缓存",
    viewer.includes("readRoleRow") && viewer.includes("不缓存") &&
      !/const \{ data: row \} = await supabase/.test(viewer),
    "viewer 已接 readRoleRow");
  record("★契约：中间件（proxy）走 readRoleRow，且 roleCache.set 只在成功分支",
    proxy.includes("readRoleRow") &&
      proxy.indexOf("roleCache.set(user.id") > proxy.indexOf("const row = await readRoleRow") &&
      proxy.indexOf("roleCache.set(user.id") < proxy.indexOf("} catch (e)") + 400,
    "proxy 已接 readRoleRow");
}

process.exit(summary() ? 0 : 1);
