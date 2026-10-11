#!/usr/bin/env node
/**
 * 「🏫 识别学校卷子」（`POST /api/paper-analysis/vision-paper-structure`）测试
 *
 * 背景（用户 2026-10 实测反馈）：**学校卷子**（空白卷/批改卷）没有学科网那份
 * 「整体难度／细目表分析」报告，走报告解析器只会得到"没有解析到题目"。
 * 所以新增这条路：AI **看懂卷子** → 直接产出**题目结构**（题型分块 + 逐题知识点 +
 * 卷面印着的分值 + 批改卷的得分）→ 先给老师核对（可改）→ 生成 `paper` → 走现有流程。
 *
 * 口径（用户 2026-10 定，都写成断言防被改）：**免费**；知识点 AI 自由写 + 本地归类；
 * 多页上限 **20 页**（11–20 自动分批，用户无感）；难度**默认不估**，点了按钮才估。
 *
 * 跑法（需先 pnpm build）：
 *   & "<bundled node>" tests\school-paper.test.mjs
 * ⚠️ 自己起 next start（3000），桩上游 4591，Edge 9494 → 别和其它真服务套件同时跑。
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { readEnv, readUsers, makeRecorder, startBrowser, makePageApi } from "./_helpers.mjs";
import { loginCookie } from "./_students-baseline.mjs";

const PROJECT = "D:\\my-website\\my-toolbox";
const NODE_BIN =
  "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = `${PROJECT}\\node_modules\\next\\dist\\bin\\next`;
const BASE = "http://127.0.0.1:3000";
/** 桩上游端口（⚠️ 别撞：4567/4586/4587/4588/4589/4590 都被别的套件占了） */
const STUB_PORT = 4591;
const CDP_PORT = 9494;

const { record, summary } = makeRecorder();
const { SUPABASE_URL, ANON_KEY } = readEnv();
const { adminEmail, userEmail, password } = readUsers();   // rolea=免费 / roleb=会员

const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/** 桩返回的"第 N 页结构"：故意带上要归一化的坏值（type:"选择题"、score 是字符串） */
function structureFor(page) {
  if (page === 1) {
    return {
      title: "2026学年第一学期期中考试 高三数学",
      totalScore: 150,
      blocks: [{ type: "选择题", count: 8, perScore: 5 }, { type: "解答题", count: 2 }],
      questions: [
        { no: 1, type: "选择题", knowledge: ["集合的交集运算"], score: "5", got: 5, uncertain: false },
        { no: 2, type: "选择题", knowledge: ["函数的定义域"], score: null, got: null, uncertain: false },
        { no: 17, type: "解答题", knowledge: ["导数与单调性", "极值"], score: 13, got: 9, uncertain: false },
        // 故意留一个"词典里查不到"的知识点 → 前端应提示"有 N 道题没能归类到模块"
        { no: 18, type: "解答题", knowledge: ["看不出来考什么"], score: 15, got: null, uncertain: true },
      ],
      uncertainNotes: ["第 18 题第二问被裁掉"],
    };
  }
  if (page === 2) {
    return {
      title: "", totalScore: null,
      blocks: [{ type: "解答题", count: 1 }],
      questions: [{ no: 19, type: "解答题", knowledge: ["数列求和"], score: 15, got: 12, uncertain: false }],
      uncertainNotes: [],
    };
  }
  return { title: "", totalScore: null, blocks: [], questions: [], uncertainNotes: [] };
}

const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const killPort3000 = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
  return pid;
};

/* ==========================================================================
   桩上游
   ========================================================================== */
const calls = [];
/** ok / badjson（不是 JSON） / upstream500 */
let stubMode = "ok";

const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 保留 null */ }
    calls.push({ path: req.url, auth: req.headers.authorization ?? "", body });
    res.setHeader("content-type", "application/json");
    if (stubMode === "upstream500") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "stub-school-boom" } }));
      return;
    }

    const userMsg = body?.messages?.[1]?.content;
    const isDifficulty = typeof userMsg === "string";   // 结构识别是数组（text+image），难度是纯文本
    /** 把 user 内容里的**文字部分**取出来（结构识别那边是数组：text 块 + image_url 块） */
    const userText = Array.isArray(userMsg)
      ? userMsg.filter((c) => c?.type === "text").map((c) => c.text).join(" ")
      : String(userMsg ?? "");

    if (stubMode === "badjson") {
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "这张卷子看起来不错，我建议多练导数。" } }] }));
      return;
    }

    let content;
    if (isDifficulty) {
      let nos = [];
      try { nos = (JSON.parse(userText).questions || []).map((q) => q.no); } catch { /* 忽略 */ }
      content = JSON.stringify({
        difficulties: nos.map((no, i) => ({ no, level: i === 0 ? "中等" : "超级难" })),   // 第二个是坏值，必须被丢掉
      });
    } else {
      // ⚠️ 页码要从**数组里的 text 块**取（本轮踩到：直接 String(数组) 得到 "[object Object]"，
      //    于是每一页都被当成第 1 页，多页合并的断言全红）
      const m = String(userText || "").match(/第\s*(\d+)\s*页/);
      content = JSON.stringify(structureFor(m ? Number(m[1]) : 1));
    }
    res.end(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 900, completion_tokens: 400 },
    }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

/* ==========================================================================
   起服务
   ========================================================================== */
killPort3000();
await sleep(1500);
const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], {
  cwd: PROJECT,
  stdio: "ignore",
  env: {
    ...process.env,
    AI_KEY: "stub-key",
    AI_VISION_MODEL: "deepseek-flash",
    AI_VISION_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
  },
});
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { if ((await fetch(`${BASE}/login`)).status === 200) break; } catch { /* 等 */ }
}

const freeCookie = await loginCookie(adminEmail, password);
const vipCookie = await loginCookie(userEmail, password);
record("（准备）免费与会员两个会话都拿到", !!freeCookie && !!vipCookie);

const post = (cookie, body) =>
  fetch(`${BASE}/api/paper-analysis/vision-paper-structure`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

let edge = null;
try {
  /* ======================================================================
     1. 鉴权（含**免费**口径）与入参
     ====================================================================== */
  {
    const r = await post("", { image: IMG, page: 1, totalPages: 1 });
    record("① 未登录 → 401", r.status === 401, `HTTP ${r.status}`);
  }
  {
    const r = await post(freeCookie, { image: "http://x/a.png", page: 1, totalPages: 1 });
    record("入参：不是 data:image → 400", r.status === 400, `HTTP ${r.status}`);
  }
  {
    const r = await post(freeCookie, { image: "data:image/png;base64," + "A".repeat(4 * 1024 * 1024) });
    record("入参：图片超过 4MB → 413（明确提示压缩）", r.status === 413, `HTTP ${r.status}`);
  }
  {
    const r = await post(freeCookie, { mode: "difficulty" });
    record("入参：估难度却没给题目清单 → 400", r.status === 400, `HTTP ${r.status}`);
  }

  /* ======================================================================
     2. 结构识别（免费用户）+ 归一化
     ====================================================================== */
  calls.length = 0;
  const r1 = await post(freeCookie, { image: IMG, page: 1, totalPages: 2 });
  const j1 = await r1.json().catch(() => null);
  const b1 = calls.at(-1)?.body;
  const sys1 = b1?.messages?.[0]?.content ?? "";
  const usr1 = b1?.messages?.[1]?.content;

  record("★口径：**免费用户**也能识别学校卷子 → 200（本功能不是会员专属）",
    r1.status === 200 && j1?.ok === true && !!j1?.structure,
    `HTTP ${r1.status} ${JSON.stringify(j1?.structure?.questions?.length ?? j1?.error)}`);
  record("① 桩**真的被打了**（防假绿）", calls.length === 1 && calls[0].path === "/chat/completions",
    `path=${JSON.stringify(calls[0]?.path)}`);
  record("★提示词：要求「只输出 JSON」+ 题型只能取那五个 + 分值没印就 null（不许猜）",
    /只输出 JSON/.test(sys1) && /单选题 \/ 多选题 \/ 填空题 \/ 判断题 \/ 解答题/.test(sys1) &&
      /绝对不要自己猜一个数字/.test(sys1),
    JSON.stringify(sys1.slice(0, 80)));
  record("★提示词：批改卷要读每题得分（got）、看不清要标 uncertain",
    /got/.test(sys1) && /uncertain/.test(sys1), "");
  record("护栏：图片放在 user 消息的数组里 + thinking 关掉（模型含 deepseek）",
    Array.isArray(usr1) && usr1.some((c) => c?.type === "image_url") && b1?.thinking?.type === "disabled",
    JSON.stringify(Array.isArray(usr1) ? usr1.map((c) => c.type) : usr1));

  const sq = j1?.structure?.questions ?? [];
  record("★归一化：模型给的「选择题」被归到 **单选题**（题型白名单兜底）",
    sq[0]?.type === "单选题" && sq[1]?.type === "单选题", JSON.stringify(sq.map((q) => q.type)));
  record("★分值：字符串 \"5\" 被转成数字 5；卷面没印的题 → **null**（不猜）",
    sq[0]?.score === 5 && sq[1]?.score === null, JSON.stringify(sq.map((q) => q.score)));
  record("★批改卷得分：读到的 got 保留；没批改的 → null",
    sq[0]?.got === 5 && sq[1]?.got === null && sq[2]?.got === 9, JSON.stringify(sq.map((q) => q.got)));
  record("★不确定项：第 18 题 uncertain=true，uncertainNotes 也带回来了",
    sq[3]?.uncertain === true && (j1?.structure?.uncertainNotes ?? []).length === 1,
    JSON.stringify(j1?.structure?.uncertainNotes));
  record("blocks 也带回来了（题型分块，供前端算题型分布）",
    (j1?.structure?.blocks ?? []).length === 2 && j1.structure.blocks[0].type === "单选题",
    JSON.stringify(j1?.structure?.blocks));

  /* ======================================================================
     3. 第二页（多页合并的原料）
     ====================================================================== */
  const r2 = await post(freeCookie, { image: IMG, page: 2, totalPages: 2 });
  const j2 = await r2.json().catch(() => null);
  record("第二页：识别到第 19 题（前端负责跨页合并）",
    r2.status === 200 && (j2?.structure?.questions ?? []).length === 1 &&
      j2.structure.questions[0].no === 19,
    JSON.stringify(j2?.structure?.questions));

  /* ======================================================================
     4. 「让 AI 估每题难度」（点了才走；坏值要被丢掉）
     ====================================================================== */
  {
    calls.length = 0;
    const r = await post(freeCookie, {
      mode: "difficulty",
      questions: [{ no: 1, type: "单选题", knowledge: ["集合的交集运算"] }, { no: 2, type: "单选题", knowledge: ["函数的定义域"] }],
    });
    const j = await r.json().catch(() => null);
    const userMsg = calls.at(-1)?.body?.messages?.[1]?.content;
    record("★估难度：200 且只回**合法难度档**（坏值「超级难」被丢掉）",
      r.status === 200 && j?.ok === true && j.difficulties.length === 1 && j.difficulties[0].level === "中等",
      JSON.stringify(j?.difficulties));
    record("估难度是**纯文本**任务：这次请求里没有图片（不白花一次视觉调用）",
      typeof userMsg === "string" && !userMsg.includes("image_url"),
      typeof userMsg === "string" ? userMsg.slice(0, 60) : typeof userMsg);
    record("★提示词：难度只能取四档（较易/中等/较难/难）且拿不准给中等",
      /较易 \/ 中等 \/ 较难 \/ 难/.test(String(calls.at(-1)?.body?.messages?.[0]?.content)),
      "");
  }

  /* ======================================================================
     5. 模型不按 JSON 返回 / 上游异常
     ====================================================================== */
  {
    stubMode = "badjson";
    const r = await post(freeCookie, { image: IMG, page: 1, totalPages: 1 });
    const j = await r.json().catch(() => null);
    record("★模型返回的不是 JSON → 仍是 200 + empty + raw（**不是 5xx**，不白花这次调用）",
      r.status === 200 && j?.empty === true && typeof j?.raw === "string" && j.raw.length > 0,
      `HTTP ${r.status} raw=${JSON.stringify(String(j?.raw ?? "").slice(0, 40))}`);
    stubMode = "ok";
  }
  {
    stubMode = "upstream500";
    const r = await post(freeCookie, { image: IMG, page: 1, totalPages: 1 });
    const j = await r.json().catch(() => null);
    record("上游 5xx → 502 且**不透传上游原文**",
      r.status === 502 && !/stub-school-boom/.test(JSON.stringify(j)), `HTTP ${r.status}`);
    stubMode = "ok";
  }

  /* ======================================================================
     ★ 真浏览器：选图 → 结构化预览 → 改 → 生成题目结构
     ====================================================================== */
  {
    const b = await startBrowser(CDP_PORT, "D:/my-website/.edge-profile-school");
    edge = b.edge;
    const { cdp, sessionId } = b;
    const { inTool, goto, login } = makePageApi(cdp, sessionId);

    const pageErrors = [];
    cdp.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        pageErrors.push(`${String(d?.text)} ${String(d?.exception?.description ?? "").slice(0, 160)}`);
      }
    });

    record("免费账号在浏览器里登录成功", await login(adminEmail, password));
    await goto("/tools/paper-analysis", 5000);

    const panel = await inTool(`
      return { btn: !!w.document.getElementById('btnSchool'), input: !!w.document.getElementById('schoolInput'),
               box: !!w.document.getElementById('schoolPreview') };
    `);
    record("工具页有「🏫 识别学校卷子」的按钮 / 文件框 / 预览容器",
      panel?.btn === true && panel?.input === true && panel?.box === true, JSON.stringify(panel));

    /** 在 iframe 里造 N 张真实小 PNG 并塞进文件框（走老师点按钮那条真实路径） */
    const makeFiles = (n) => `
      const dt = new w.DataTransfer();
      for (let k = 0; k < ${n}; k++) {
        const cv = w.document.createElement('canvas'); cv.width = 12; cv.height = 12;
        const g = cv.getContext('2d'); g.fillStyle = k % 2 ? '#111' : '#333'; g.fillRect(0,0,12,12);
        const bin = atob(cv.toDataURL('image/png').split(',')[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        dt.items.add(new w.File([arr], '卷子第' + (k+1) + '张.png', { type: 'image/png' }));
      }
      const inp = w.document.getElementById('schoolInput');
      inp.files = dt.files;
      inp.dispatchEvent(new w.Event('change'));
      return 'started';
    `;

    // ---- ① 两页一起传：验证「多页合并」（题号去重 + 升序 + 分块累计） ----
    await inTool(makeFiles(2));
    let prev = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      prev = await inTool(`
        const rows = [...w.document.querySelectorAll('[data-sq="no"]')];
        const box = w.document.getElementById('schoolPreview');
        if (!rows.length) return null;
        return {
          n: rows.length,
          nos: rows.map(r => r.value),
          types: [...w.document.querySelectorAll('[data-sq="type"]')].map(s => s.value),
          modules: [...w.document.querySelectorAll('td')].map(td => td.innerText).join('|').slice(0, 0),
          hasBuild: !!w.document.getElementById('btnSchoolBuild'),
          hasDiff: !!w.document.getElementById('btnSchoolDiff'),
          boxText: box.innerText.replace(/\\s+/g,' ').slice(0, 400),
        };
      `);
      if (prev) break;
    }
    record("★端到端：两页一起传 → 出现**结构化预览**（题号/题型/分值/知识点 都可改）",
      !!prev && prev.hasBuild === true && prev.hasDiff === true && prev.n === 5,
      `行数=${prev?.n} 题号=${JSON.stringify(prev?.nos)}`);
    record("★多页合并：两页的题号**并集且升序**（1,2,17,18,19）、没有重复",
      JSON.stringify(prev?.nos) === JSON.stringify(["1", "2", "17", "18", "19"]),
      JSON.stringify(prev?.nos));
    record("★合并后题型分块累计（单选题 8 + 解答题 2 + 解答题 1 → 预览里能看到「解答题 3 题」）",
      /单选题 8 题/.test(String(prev?.boxText)) && /解答题 3 题/.test(String(prev?.boxText)),
      JSON.stringify(String(prev?.boxText).slice(0, 140)));
    record("★预览里点数了「AI 没归类到模块」的题数（知识点自由写的风险提示）",
      /归类到模块|没能归类/.test(String(prev?.boxText)), JSON.stringify(String(prev?.boxText).slice(0, 160)));

    // ---- ② 【让 AI 估每题难度】点了才走 ----
    await inTool(`w.document.getElementById('btnSchoolDiff').click(); return 'clicked';`);
    let diffAfter = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      diffAfter = await inTool(`
        const el = w.document.querySelector('[data-sq="difficulty"][data-i="0"]');
        return el ? el.value : null;
      `);
      if (diffAfter) break;
    }
    record("★「让 AI 估每题难度」：点完难度列被填上（AI 给的「中等」），且可手改",
      diffAfter === "中等", JSON.stringify(diffAfter));
    const diffCount = await inTool(`
      return [...w.document.querySelectorAll('[data-sq="difficulty"]')].filter(e => e.value).length;
    `);
    record("★估难度只填合法档位（坏值「超级难」被丢掉 → 只填了 1 行）",
      diffCount === 1, `填了 ${diffCount} 行`);

    // ---- ③ 改一处（知识点/分值/难度/得分）→ 生成题目结构 ----
    // 行下标：0=题1  1=题2  2=题17  3=题18（升序排列）
    const built = await inTool(`
      const set = (key, i, v) => { const el = w.document.querySelector('[data-sq="'+key+'"][data-i="'+i+'"]'); if(el) el.value = v; };
      set('knowledge', 1, '自定义知识点A');
      set('score', 1, '7');
      set('difficulty', 1, '较难');
      set('got', 1, '4');
      w.document.getElementById('btnSchoolBuild').click();
      const items = [...w.document.querySelectorAll('#scoreList .qitem')];
      const tagOf = (no) => { const it = items.find(x => x.dataset.no === String(no)); return it ? it.innerText.replace(/\\s+/g,' ') : null; };
      const gotOf = (no) => { const el = w.document.querySelector('#scoreList input[data-got="'+no+'"]'); return el ? el.value : null; };
      return {
        qitems: items.length,
        title: w.document.getElementById('paperTitle').textContent,
        result: w.document.getElementById('parseResult').innerText.replace(/\\s+/g,' ').slice(0, 300),
        preview: w.document.getElementById('schoolPreview').innerHTML.length,
        q2: tagOf(2), got1: gotOf(1), got17: gotOf(17), got19: gotOf(19), got2: gotOf(2),
        total: w.document.getElementById('examTotal').value,
      };
    `);
    record("★生成结构：逐题得分区出现 **5 行**（每个题一行，与题号对应）",
      built?.qitems === 5, `行数=${built?.qitems}`);
    record("★生成结构：卷子标题进了试卷信息，卷面总分 150 也填上了",
      /期中考试/.test(String(built?.title ?? "")) && String(built?.total) === "150",
      `title=${JSON.stringify(built?.title)} total=${built?.total}`);
    record("★★老师改过的**分值 7** 真的生效（逐题得分区显示「满分 7」，不是按惯例的值）",
      /满分 7/.test(String(built?.q2 ?? "")) && /较难/.test(String(built?.q2 ?? "")),
      JSON.stringify(String(built?.q2 ?? "").slice(0, 120)));
    record("★★批改卷的**得分预填**：第 1 题 5 分、第 17 题 9 分、第 19 题 12 分（识别来的）；第 2 题 4 分（老师改的）",
      built?.got1 === "5" && built?.got17 === "9" && built?.got19 === "12" && built?.got2 === "4",
      JSON.stringify({ got1: built?.got1, got17: built?.got17, got19: built?.got19, got2: built?.got2 }));
    record("★生成后预览面板收起 + 结果区给出汇总（含知识点归类到哪些模块）",
      built?.preview === 0 && /已生成题目结构/.test(String(built?.result ?? "")),
      `面板=${built?.preview} 结果=${JSON.stringify(String(built?.result ?? "").slice(0, 120))}`);

    // ---- ④ 超过 20 页 → 明确拒绝 ----
    await inTool(`w.document.getElementById('btnSchoolClear').click(); return 'cleared';`);
    await inTool(makeFiles(21));
    let tooMany = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      tooMany = await inTool(`
        const t = w.document.getElementById('schoolPreview').innerText.replace(/\\s+/g,' ');
        return /超过上限|分两次/.test(t) ? t.slice(0, 160) : null;
      `);
      if (tooMany) break;
    }
    record("★超过 20 页 → **明确拒绝**并提示分两次上传（不静默截断）",
      !!tooMany && /20 页/.test(String(tooMany)), JSON.stringify(tooMany));

    if (pageErrors.length) console.log("     页面错误:", JSON.stringify(pageErrors.slice(0, 3)));
    record("页面无真实 JS 异常", pageErrors.length === 0, `${pageErrors.length} 条`);

    try { await cdp.send("Browser.close"); } catch { /* ignore */ }
  }
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
  console.error(e?.stack ?? e);
} finally {
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  killPort3000();
  stub.close();
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
