#!/usr/bin/env node
/**
 * 新注册自动送 15 天会员（迁移 0023）· **静态契约测试**
 * ==========================================================================
 * 为什么是“静态契约”而不是真注册：
 *   · 本地测试只有 anon key，**没有 service_role** ⇒ 不能在 Node 里建 auth 用户；
 *     用公开 signup 建会真的发确认邮件、而且删不掉（没有 service_role）。
 *   · 所以这里钉住“SQL 必须长成什么样”；**运行期**由
 *     `supabase/tests/0023_auto_grant_vip_test.sql` 在 SQL Editor 里验
 *     （事务里插一个临时 auth 用户 → 检查 → rollback，不留数据）。
 *   · 真实验收步骤见 `docs/auto-trial-vip-plan.md`。
 *
 * 这个套件**不需要服务、不需要浏览器**，纯读文件。
 */
import { readFileSync } from "node:fs";
import { makeRecorder } from "./_helpers.mjs";

const { record, summary } = makeRecorder();

const SQL_PATH = "supabase/migrations/0023_auto_grant_vip.sql";
const TEST_PATH = "supabase/tests/0023_auto_grant_vip_test.sql";

/** 去掉 SQL 注释后再断言，避免“注释里提到旧写法”造成假红/假绿 */
const stripSqlComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

let raw = "";
let sql = "";
let testRaw = "";
try { raw = readFileSync(SQL_PATH, "utf8"); sql = stripSqlComments(raw); } catch { /* 下面报 */ }
try { testRaw = readFileSync(TEST_PATH, "utf8"); } catch { /* 下面报 */ }

record("① 迁移文件存在且不是空壳",
  raw.length > 500 && /create\s+or\s+replace\s+function\s+public\.grant_trial_vip_on_signup\s*\(\s*\)/i.test(sql),
  `${SQL_PATH}（${raw.length} 字节）`);

record("② 触发器挂在 auth.users 的 after insert（注册即生效，不靠前端）",
  /after\s+insert\s+on\s+auth\.users/i.test(sql) &&
    /create\s+trigger\s+on_auth_user_created_grant_trial_vip/i.test(sql) &&
    !/after\s+update\s+on\s+auth\.users/i.test(sql),
  "只监听 insert，不监听 update");

record("③ 函数是 security definer + 空 search_path（触发器要能绕过 RLS 写 user_roles）",
  /security\s+definer/i.test(sql) && /set\s+search_path\s*=\s*''/i.test(sql),
  "security definer / search_path = ''");

record("④ 插入 user_roles 的列齐全（user_id + role + plan + status + expires_at + 时间戳）",
  /insert\s+into\s+public\.user_roles\s*\(\s*user_id\s*,\s*role\s*,\s*plan\s*,\s*status\s*,\s*expires_at\s*,\s*created_at\s*,\s*updated_at\s*\)/i.test(sql),
  "列清单");

record("★⑤ 规则精确：new.id / role=user / plan=vip / status=active / now()+15 days",
  /values\s*\(\s*new\.id\s*,\s*'user'\s*,\s*'vip'\s*,\s*'active'\s*,\s*now\(\)\s*\+\s*interval\s*'15 days'\s*,\s*now\(\)\s*,\s*now\(\)\s*\)/i.test(sql),
  "15 days（不是 14 / 30）");

record("★⑥ 不覆盖已有行：on conflict (user_id) do nothing（管理员手动开通过也不冲突）",
  /on\s+conflict\s*\(\s*user_id\s*\)\s*do\s+nothing/i.test(sql),
  "do nothing");

record("★⑦ 不回溯老用户：没有 update / delete user_roles，也没有 insert ... select",
  !/(?:update|delete)\s+(?:from\s+)?public\.user_roles/i.test(sql) &&
    !/insert\s+into\s+public\.user_roles[\s\S]{0,240}?select/i.test(sql),
  "只 insert 新行");

record("★⑧ 不把注册搞崩：异常只 raise warning 并 return new（送会员失败也不拦注册）",
  /exception\s+when\s+others\s+then[\s\S]{0,240}?raise\s+warning[\s\S]{0,140}?return\s+new/i.test(sql),
  "warning + return new");

record("⑨ 可重复执行：create or replace function + drop trigger if exists",
  /create\s+or\s+replace\s+function/i.test(sql) &&
    /drop\s+trigger\s+if\s+exists\s+on_auth_user_created_grant_trial_vip\s+on\s+auth\.users/i.test(sql),
  "幂等");

record("⑩ 触发器函数不给前端直接执行（revoke from public）",
  /revoke\s+all\s+on\s+function\s+public\.grant_trial_vip_on_signup\s*\(\s*\)\s+from\s+public/i.test(sql),
  "revoke execute");

record("⑪ 这不是改表结构：没有 add/drop column、create table、drop table",
  !/(?:alter\s+table[\s\S]{0,160}?(?:add|drop)\s+column|create\s+table|drop\s+table)/i.test(sql),
  "只加函数与触发器");

record("⑫ 运行期自检文件在，且会插临时 auth 用户、查 user_roles、最后 rollback（不留数据）",
  testRaw.length > 300 &&
    /insert\s+into\s+auth\.users/i.test(testRaw) &&
    /from\s+public\.user_roles/i.test(testRaw) &&
    /rollback\s*;/i.test(testRaw) &&
    /v_days\s*<\s*14\.9\s+or\s+v_days\s*>\s*15\.1/i.test(testRaw),
  `${TEST_PATH}（${testRaw.length} 字节）`);

summary();
