#!/usr/bin/env node
/**
 * 全学科试卷分析 v2 · AI 路由静态契约测试
 * ==========================================================================
 * 不真调上游（本地无 Key）。钉住服务端必须有的护栏：
 *   · 会员专属 / 未登录 401 / 封禁 403 / 无 Key 503；
 *   · 只接受 stem / attribution 两种 section；
 *   · stem 返回行数必须与题数一致（错位宁可 502）；
 *   · attribution 必须是恰好三个键的 JSON；
 *   · 关闭 thinking、错误不透传上游原文；
 *   · 前端确实调用这个路由。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeRecorder } from "./_helpers.mjs";

const { record, summary } = makeRecorder();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "src/app/api/paper-analysis-v2/ai/route.ts"), "utf8");
const APP = readFileSync(join(ROOT, "public/tools/paper-analysis-v2/js/app.js"), "utf8");

record("① 路由存在且是 POST，走会员专属 requireVip",
  /export async function POST/.test(SRC) && /requireVip\(\)/.test(SRC),
  "POST + requireVip");

record("② 未登录 401 / 封禁 403 / 非会员 403 / 无 Key 503（四种都给中文出路）",
  /status:\s*401/.test(SRC) && /status:\s*403/.test(SRC) && /status:\s*503/.test(SRC) &&
    /请先登录/.test(SRC) && /账号已被封禁/.test(SRC) && /会员专属/.test(SRC) && /未配置 AI Key/.test(SRC),
  "401/403/503");

record("③ 只接受 stem / attribution 两个 section（其它 400）",
  /section\s*!==\s*"stem"\s*&&\s*section\s*!==\s*"attribution"/.test(SRC) && /status:\s*400/.test(SRC),
  "section 白名单");

record("★④ 题干摘要：要求行数 = 题数，不一致就 502（绝不错位贴）",
  /lines\.length\s*!==\s*stemsQuestions\.length/.test(SRC) &&
    /AI 返回的摘要条数与题目不一致/.test(SRC) && /status:\s*502/.test(SRC),
  "行数契约");

record("★⑤ 附件1 归因：要求恰好三个键（学生角度/教师角度/其它原因）",
  /\["学生角度",\s*"教师角度",\s*"其它原因"\]/.test(SRC) &&
    /AI 返回的归因格式不正确/.test(SRC),
  "三键契约");

record("⑥ 提示词明确「不要编造分数/题号」「不下定论/不贴标签」",
  /不要编造/.test(SRC) && /不给孩子贴标签/.test(SRC),
  "反编造/反标签");

record("⑦ 关闭 thinking（DeepSeek 专用字段）且上限 6000",
  /thinkingDisabled\(model\)/.test(SRC) && /MAX_TOKENS\s*=\s*6000/.test(SRC),
  "thinkingDisabled + 6000");

record("⑧ 上游错误只回中文，不透传原文",
  /AI 服务暂时不可用/.test(SRC) && !/error:\s*String\(e\)/.test(SRC),
  "错误口径");

record("⑨ 一次最多 60 题 / 请求体上限 40k（超了 413）",
  /MAX_QUESTIONS\s*=\s*60/.test(SRC) && /MAX_PAYLOAD\s*=\s*40_000/.test(SRC) && /status:\s*413/.test(SRC),
  "60 题 / 40k");

record("⑩ 新界面确实调用这个 AI 路由（题干摘要 + 归因两个按钮）",
  /\/api\/paper-analysis-v2\/ai/.test(APP) && /section:\s*'stem'/.test(APP) && /section:\s*'attribution'/.test(APP),
  "app.js → route");

const ok = summary();
process.exit(ok ? 0 : 1);
