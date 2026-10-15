#!/usr/bin/env node
/**
 * 「图片 / 截图识别」（`POST /api/paper-analysis/vision-paper`）测试
 *
 * 这是用户 2026-10 排的第二件（PDF/照片 → AI 解析卷子内容）里的**图片那一半**：
 * 把学科网报告的截图/拍照交给视觉模型**逐字抄录**，拿回文本后**先给老师核对**，
 * 再一键填进导入框走原有解析流程。
 *
 * 口 径（用户 2026-10 明确定，写进断言里防止被"统一"改掉）：
 *   · **免费** —— 只校验"登录 + 未封禁"，**不是会员专属**；
 *   · 一页一张分别识别；
 *   · 尽力识别 + **标出不确定的地方**（`[看不清]`）；
 *   · 先预览核对、再一键填进导入框。
 *
 * 本套件分两阶段起服务（因为「未配视觉模型」只能在没有该环境变量时验）：
 *   阶段① 不配 `AI_VISION_MODEL` → 401 / 503
 *   阶段② 配 stub 上游 → 免费可用、请求体与提示词、uncertain/empty、上游异常、真浏览器全流程
 *
 * 跑法（需先 pnpm build）：
 *   & "<bundled node>" tests\vision-paper.test.mjs
 * ⚠️ 自己起 next start（3000）→ 别和其它真服务套件同时跑。
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
/** 桩上游端口（⚠️ 别撞：4567 ai-apply / 4586 ai-thinking / 4587 vision-scores / 4588 student-analysis / 4589 attribution） */
const STUB_PORT = 4590;
const CDP_PORT = 9492;

const { record, summary } = makeRecorder();
const { SUPABASE_URL, ANON_KEY } = readEnv();
const { adminEmail, userEmail, password } = readUsers();   // rolea=免费管理员 / roleb=会员

const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
/** 桩返回的「学科网报告」样式文本（含标题/题型/细目表），便于前端解析链路也走通 */
const REPORT_TEXT = [
  "2026届高三第一次月考数学试卷分析报告",
  "整体难度：0.62",
  "试卷题型 | 题目数量 | 总分值",
  "单选题 | 8 | 40",
  "解答题 | 5 | 77",
  "细目表分析",
  "题号 | 题型 | 分值 | 难度系数 | 知识点",
  "1 | 单选题 | 5 | 0.85 | 集合与常用逻辑用语",
  "2 | 单选题 | 5 | 0.72 | 函数概念与性质",
  "17 | 解答题 | 13 | 0.55 | 导数及其应用",
  "18 | 解答题 | 15 | 0.48 | 平面解析几何",
].join("\n");

const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();

/** 造一份**真的没有文字层**的最小 PDF（只有一页 + 一个黑色方块，没有任何文字操作符）。
 *  用途：验证客户端「服务器抽不到文字 → 用 pdf.js 逐页渲染 → 走视觉识别」这条回退路径。
 *  ⚠️ xref 的字节偏移必须算对，否则 pdf.js 可能拒绝解析 —— 这里逐对象累加长度算出来的。 */
function buildScannedPdf() {
  const content = "0.1 0.1 0.1 rg 20 20 260 360 re f\n";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
const killPort3000 = () => {
  const pid = ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");
  if (pid) ps(`Stop-Process -Id ${pid} -Force`);
  return pid;
};
async function startServerWithEnv(extraEnv, dropKeys = []) {
  killPort3000();
  await sleep(1500);
  const env = { ...process.env, ...extraEnv };
  for (const k of dropKeys) delete env[k];
  const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], { cwd: PROJECT, stdio: "ignore", env });
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { if ((await fetch(`${BASE}/login`)).status === 200) return srv; } catch { /* 等 */ }
  }
  return srv;
}

/* ==========================================================================
   桩上游
   ========================================================================== */
const calls = [];
/** ok / uncertain（含 [看不清]） / empty（空文本） / upstream500 */
let stubMode = "ok";
/** 桩要返回的文本：默认是我编的极简报告；测试会用 `POST /__set` 换成**工具自带示例**（更真实） */
let stubText = REPORT_TEXT;
/** ★ 2026-10 第十七批：给"只重试失败那一页"用的故障注入。
 *  `failNth`: 第几次请求（1 起）回 500；`onlyFirst`: 只失效那一次（重试就能成功）。
 *  `failPage`: 只让 `body.page === N` 的请求回 500（学校卷子那条管线带 page 号）。
 *  ⚠️ 为什么按 page 号：桩**看不见**客户端算出来的 dataUrl（压缩后的图），
 *    按 body 里的 page 号定位最稳。 */
let failNth = 0, onlyFirst = true, failPage = 0;
let nth = 0;
const countByPage = {};

const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    // 控制口：让测试把"桩该返回的文本"换成工具自带的示例报告
    if (req.url === "/__set") {
      try {
        const j = JSON.parse(raw);
        stubText = String(j.text ?? REPORT_TEXT);
        if (typeof j.failNth === "number") { failNth = j.failNth; nth = 0; }
        if (typeof j.onlyFirst === "boolean") onlyFirst = j.onlyFirst;
        if (typeof j.failPage === "number") { failPage = j.failPage; countByPage[failPage] = 0; }
      } catch { /* 忽略 */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, chars: stubText.length }));
      return;
    }
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 保留 null */ }
    calls.push({ path: req.url, auth: req.headers.authorization ?? "", body });
    const n = ++nth;
    // ⚠️ 两条管线都**不从请求体里带页码**：结构识别把页码**拼进提示词**（"第 N 页"），
    //    报告识别连页码都没有。所以这里统一从整个请求体文本里抠页码，再计数。
    const promptPage = (() => {
      const m = JSON.stringify(body ?? {}).match(/第 (\d+) 页/);
      return m ? Number(m[1]) : 0;
    })();
    if (promptPage) countByPage[promptPage] = (countByPage[promptPage] ?? 0) + 1;
    // ★ 故障注入：按"第几次请求"或"哪一页"回 500
    const byNth = failNth > 0 && n === failNth && (onlyFirst ? true : n >= failNth);
    const byPage = failPage > 0 && promptPage === failPage && countByPage[promptPage] === 1;
    if (byNth || byPage) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: "stub-vision-paper-boom" } }));
      return;
    }
    res.setHeader("content-type", "application/json");
    if (stubMode === "upstream500") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "stub-vision-paper-boom" } }));
      return;
    }
    // ⚠️ **学校卷子那条管线要的是"结构 JSON"**（`vision-paper-structure` 让模型直接产出
    //    {structure:{…}}），而报告那条要的是**纯文本**。桩没法靠请求体里的 `page` 判别
    //    —— 页码是**拼进提示词**的（实测踩到：第一版按 body.page 判别，于是永远走了文本分支，
    //    新用例表现成"没有认出任何题目"）。所以按**提示词特征**判别。
    const allText = JSON.stringify(body ?? {});
    const wantsStructure = /请按约定输出 JSON|题型分块/.test(allText);
    if (wantsStructure) {
      // 页码从提示词里抠出来（"这是试卷的第 N 页"），好用 page 号注入故障与断言
      const m = allText.match(/第 (\d+) 页/);
      const page = m ? Number(m[1]) : 1;
      res.end(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
          title: "桩卷", totalScore: 150,
          blocks: [{ name: "单选题", count: 1 }],
          questions: [{ no: page, type: "单选题", full: 5, got: null, knowledge: "桩知识点" + page }],
          uncertainNotes: [],
        }) } }],
        usage: { prompt_tokens: 900, completion_tokens: 200 },
      }));
      return;
    }
    const content =
      stubMode === "empty" ? ""
        : stubMode === "uncertain" ? stubText + "\n第 19 题题干 [看不清]"
          : stubText;
    res.end(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 900, completion_tokens: 400 },
    }));
  });
});
await new Promise((r) => stub.listen(STUB_PORT, "127.0.0.1", r));

const post = (cookie, body) =>
  fetch(`${BASE}/api/paper-analysis/vision-paper`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

let srv = null;
let edge = null;
try {
  /* ======================================================================
     阶段①：**不配** AI_VISION_MODEL → 未登录 401 / 免费用户 503（明确提示）
     ====================================================================== */
  srv = await startServerWithEnv({ AI_KEY: "stub-key" }, ["AI_VISION_MODEL"]);
  {
    const freeCookieA = await loginCookie(adminEmail, password);
    const rAnon = await post("", { image: IMG });
    record("① 未登录 → 401", rAnon.status === 401, `HTTP ${rAnon.status}`);

    const before = calls.length;
    const rNoModel = await post(freeCookieA, { image: IMG });
    const jNoModel = await rNoModel.json().catch(() => null);
    record("① 未配 AI_VISION_MODEL → 503 且提示明确（不是 500，也不去调上游）",
      rNoModel.status === 503 && /未启用图片识别/.test(jNoModel?.error ?? "") && calls.length === before,
      `HTTP ${rNoModel.status} ${JSON.stringify(jNoModel?.error)}`);
  }
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });

  /* ======================================================================
     阶段②：配上视觉模型（桩上游）
     ====================================================================== */
  srv = await startServerWithEnv({
    AI_KEY: "stub-key",
    AI_VISION_MODEL: "deepseek-flash",
    AI_VISION_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
  }, ["AI_VISION_SUPPORTS_THINKING"]);

  const freeCookie = await loginCookie(adminEmail, password);   // rolea = 免费
  const vipCookie = await loginCookie(userEmail, password);     // roleb = 会员
  record("（准备）免费与会员两个会话都拿到", !!freeCookie && !!vipCookie);

  // ---- ★ 口径：免费用户也能用（这是本功能与其它三个 AI 功能最大的不同）----
  stubMode = "ok";
  calls.length = 0;
  const rFree = await post(freeCookie, { image: IMG });
  const jFree = await rFree.json().catch(() => null);
  const b1 = calls.at(-1)?.body;
  const sys1 = b1?.messages?.[0]?.content ?? "";
  const usr1 = b1?.messages?.[1]?.content;

  record("★口径：**免费用户**（rolea，非会员）也能识别 → 200（本功能不是会员专属）",
    rFree.status === 200 && jFree?.ok === true && typeof jFree?.text === "string" && jFree.text.length > 0,
    `HTTP ${rFree.status} ${JSON.stringify(String(jFree?.text ?? jFree?.error ?? "").slice(0, 60))}`);
  record("识别结果**逐字透传**（桩返回什么就回到什么）+ chars 对得上",
    jFree?.text === REPORT_TEXT && jFree?.chars === REPORT_TEXT.length,
    `chars=${jFree?.chars} 期望=${REPORT_TEXT.length}`);
  record("未标不确定时 uncertain=false", jFree?.uncertain === false, String(jFree?.uncertain));
  record("⑦ 桩**真的被打了**（否则上面几条可能是假绿）",
    calls.length === 1 && calls[0].path === "/chat/completions" && calls[0].auth === "Bearer stub-key",
    `path=${JSON.stringify(calls[0]?.path)}`);

  // ---- 请求体 / 提示词 ----
  record("★提示词：要求「逐字抄录、不要翻译/总结/改写」并保留结构与表格",
    /逐字抄录/.test(sys1) && /不要翻译/.test(sys1) && /表格/.test(sys1),
    JSON.stringify(sys1.slice(0, 80)));
  record("★提示词：看不清要写成 `[看不清]`、**绝对不要猜**（用户口径：标出不确定的地方）",
    sys1.includes("[看不清]") && /不要猜|绝对不要猜/.test(sys1), "");
  record("护栏：图片放在 **user** 消息的 content 数组里；system 只有文本（放 system 会 400）",
    Array.isArray(usr1) && usr1.some((c) => c?.type === "image_url" && c.image_url?.url === IMG) &&
      usr1.some((c) => c?.type === "text") && typeof sys1 === "string" && !sys1.includes("image_url"),
    JSON.stringify(Array.isArray(usr1) ? usr1.map((c) => c.type) : usr1));
  record("护栏：模型名含 deepseek → 带 thinking:{type:\"disabled\"}，max_tokens=6000",
    b1?.thinking?.type === "disabled" && b1?.max_tokens === 6000 && b1?.model === "deepseek-flash",
    `thinking=${JSON.stringify(b1?.thinking)} max_tokens=${b1?.max_tokens}`);

  // ---- uncertain / empty ----
  {
    stubMode = "uncertain";
    const r = await post(freeCookie, { image: IMG });
    const j = await r.json().catch(() => null);
    record("★标出不确定：文本里出现 `[看不清]` → uncertain:true（前端据此提醒必须人工补）",
      r.status === 200 && j?.uncertain === true && String(j?.text).includes("[看不清]"),
      `uncertain=${j?.uncertain}`);
  }
  {
    stubMode = "empty";
    const r = await post(freeCookie, { image: IMG });
    const j = await r.json().catch(() => null);
    record("★一个字都没认出来 → 仍是 200 + empty:true（**不是 5xx**：图不行 ≠ 系统坏了）",
      r.status === 200 && j?.ok === true && j?.empty === true && j?.text === "",
      `HTTP ${r.status} empty=${j?.empty}`);
    stubMode = "ok";
  }

  // ---- 上游异常 / 入参 ----
  {
    stubMode = "upstream500";
    const r = await post(freeCookie, { image: IMG });
    const j = await r.json().catch(() => null);
    record("上游 5xx → 502，且**不透传上游原文**", r.status === 502 && !/stub-vision-paper-boom/.test(JSON.stringify(j)),
      `HTTP ${r.status} ${JSON.stringify(j)}`);
    stubMode = "ok";
  }
  {
    const r1 = await post(freeCookie, { image: "http://example.com/a.png" });
    record("入参：不是 data:image/ 的图片 → 400", r1.status === 400, `HTTP ${r1.status}`);
    const r2 = await post(freeCookie, {});
    record("入参：完全没带 image → 400", r2.status === 400, `HTTP ${r2.status}`);
    const r3 = await post(freeCookie, { image: "data:image/png;base64," + "A".repeat(4 * 1024 * 1024) });
    record("入参：超过 4MB → 413（明确提示压缩，不是静默截断）", r3.status === 413, `HTTP ${r3.status}`);
  }

  /* ======================================================================
     ★ 扫描版 PDF 的前置事实：服务器**抽不到文字**（这正是客户端要回退的原因）
     ====================================================================== */
  const scannedPdf = buildScannedPdf();
  const scannedDataUrl = "data:application/pdf;base64," + scannedPdf.toString("base64");
  {
    const r = await fetch(`${BASE}/api/paper-analysis/parse-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: freeCookie },
      body: JSON.stringify({ name: "扫描版.pdf", data: scannedDataUrl }),
    });
    const j = await r.json().catch(() => null);
    record("（前置）这份测试 PDF 确实**没有文字层**：parse-file 认出 kind=pdf 但抽不到文字",
      r.status === 200 && j?.kind === "pdf" && !String(j?.text ?? "").trim(),
      `kind=${j?.kind} text 长度=${String(j?.text ?? "").length} note=${JSON.stringify(String(j?.note ?? "").slice(0, 60))}`);
  }

  /* ======================================================================
     ★ 真浏览器：选图 → 逐张识别 → 预览核对（可改）→ 填进导入框
     ====================================================================== */
  {
    const b = await startBrowser(CDP_PORT, "D:/my-website/.edge-profile-vision-paper");
    edge = b.edge;
    const { cdp, sessionId } = b;
    const { ev, goto, inTool, login } = makePageApi(cdp, sessionId);

    record("免费账号在浏览器里登录成功", await login(adminEmail, password));
    await goto("/tools/paper-analysis", 5000);

    // 捕获页面里的真实 JS 异常（失败时能直接看到栈，而不是只看到"面板没收起"）
    const pageErrors = [];
    cdp.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.exceptionThrown") {
        const d = m.params.exceptionDetails;
        pageErrors.push(`${String(d?.text)} ${String(d?.exception?.description ?? "").slice(0, 200)}`);
      }
    });

    const hasBtn = await inTool(`
      return { btn: !!w.document.getElementById('btnVision'), input: !!w.document.getElementById('visionInput') };
    `);
    record("工具页有「上传图片 / 截图识别」按钮与多选文件框", hasBtn?.btn === true && hasBtn?.input === true,
      JSON.stringify(hasBtn));

    // ★ pdf.js 必须是**懒加载**：打开页面时不能已经把它拉下来（1.4MB，不用识别时不该付这个代价）
    const lazy0 = await inTool(`
      const sc = w.document.querySelector('script[data-src="vendor/pdf.min.js"]');
      const all = [...w.document.querySelectorAll('script[src]')].map(s => s.getAttribute('src'));
      return { pdfScriptTag: !!sc, pdfLib: !!w.pdfjsLib, scripts: all };
    `);
    record("★懒加载①：刚打开工具页时**没有**加载 pdf.js（index.html 里没有它的 <script>）",
      lazy0?.pdfScriptTag === false && lazy0?.pdfLib === false,
      `脚本=[${(lazy0?.scripts ?? []).join(", ")}]`);

    // ★ 让桩返回**工具自带的示例报告**（而不是我编的极简文本）：
    //   这样后面"解析成功"这条链路是真实的；极简合成文本会在算分表那一步暴露缺口（本轮踩到）。
    const demoText = await inTool(`
      w.document.getElementById('btnDemo').click();
      const t = w.document.getElementById('paperPaste').value || '';
      return { len: t.length, head: t.slice(0, 40) };
    `);
    let demoFull = "";
    if (demoText?.len > 200) {
      demoFull = String(await inTool(`return w.document.getElementById('paperPaste').value;`));
      const set = await fetch(`http://127.0.0.1:${STUB_PORT}/__set`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: demoFull }),
      }).then((r) => r.json()).catch(() => null);
      record(`（准备）用工具自带示例报告当识别文本（${demoFull.length} 字，已交给桩）`,
        !!set?.ok, JSON.stringify(demoText));
    } else {
      record("（准备）载入示例报告", false, JSON.stringify(demoText));
    }
    await inTool(`w.document.getElementById('btnClearPaper').click(); return 'cleared';`);

    // 在 iframe 里造一张真实的小 PNG（canvas → dataURL → Uint8Array → File），
    // **塞进真正的 `<input type=file>` 并派发 change** —— 走的就是老师点按钮选文件那条路。
    // ⚠️ 两处坑（本轮都踩到）：
    //   1. `inTool` 的求值是**同步** IIFE → 这里不能写 await；
    //   2. `app.js` 整体包在 IIFE 里 → `w.visionRun` **不在 window 上**，
    //      所以只能驱动 UI，不能直接调内部函数（这样测也更真）。
    const started = await inTool(`
      const cv = w.document.createElement('canvas'); cv.width = 12; cv.height = 12;
      const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0,0,12,12);
      const dataUrl = cv.toDataURL('image/png');
      const bin = atob(dataUrl.split(',')[1]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const f = new w.File([arr], '探针截图.png', { type: 'image/png' });
      const dt = new w.DataTransfer();
      dt.items.add(f);
      const inp = w.document.getElementById('visionInput');
      inp.files = dt.files;
      inp.dispatchEvent(new w.Event('change'));
      return 'started:' + inp.files.length;
    `);
    if (!String(started).startsWith("started")) record("（准备）在页面里发起识别", false, JSON.stringify(started));

    // 轮询等预览出现（识别要经过压缩 + 一次接口往返）
    let preview = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      preview = await inTool(`
        const ta = w.document.querySelector('[data-vision="0"]');
        const box = w.document.getElementById('visionPreview');
        return ta ? { text: ta.value, boxText: box.innerText.slice(0, 400), hasAdopt: !!w.document.getElementById('btnVisionAdopt') } : null;
      `);
      if (preview) break;
    }
    record("★端到端：识别后出现**预览面板**（文本域里是识别结果，且有「确认填进导入框」按钮）",
      !!preview && String(preview.text).length > 200 &&
        String(preview.text).slice(0, 40) === String(demoFull).slice(0, 40) && preview.hasAdopt === true,
      JSON.stringify(String(preview?.text ?? "").slice(0, 80)));

    // 老师改一处 → 确认 → 应该以"改后的文本"填进导入框（#paperPaste 是 adoptPaperText 写入的地方）
    const adopted = await inTool(`
      const ta = w.document.querySelector('[data-vision="0"]');
      ta.value = ta.value + '\\n[老师补充] 第 19 题看不清，已让学生重做';
      w.document.getElementById('btnVisionAdopt').click();
      const pv = w.document.getElementById('visionPreview');
      const pr = w.document.getElementById('parseResult');
      return { paste: w.document.getElementById('paperPaste').value,
               result: pr.innerText.slice(0, 200),
               resultHtml: pr.innerHTML.slice(0, 200),
               pvHtml: pv.innerHTML.slice(0, 160),
               preview: pv.innerHTML.length,
               stepOn: (w.document.querySelector('.col.on') || {}).id || null };
    `);
    record("★确认后：**老师改过的文本**（不是模型原文）填进了导入框",
      String(adopted?.paste ?? "").includes("[老师补充]") && String(adopted?.paste ?? "").length > 200,
      JSON.stringify(String(adopted?.paste ?? "").slice(0, 100)));
    record("★确认后预览面板收起（不挡着下面的录入区）", adopted?.preview === 0,
      `面板 HTML 长度=${adopted?.preview} 片段=${JSON.stringify(adopted?.pvHtml)} `
        + `页面异常=${JSON.stringify(pageErrors.slice(0, 2))}`);
    record("★解析结果区给了反馈（要么解析成功，要么把识别原文摊开给老师复制）",
      /解析成功|没能自动解析|没有解析到题目/.test(String(adopted?.result ?? "")) ||
        /解析成功|没能自动解析|没有解析到题目/.test(String(adopted?.resultHtml ?? "")),
      `innerText=${JSON.stringify(String(adopted?.result ?? "").slice(0, 80))} `
        + `innerHTML=${JSON.stringify(String(adopted?.resultHtml ?? "").slice(0, 80))} step=${adopted?.stepOn} `
        + `页面异常=${JSON.stringify(pageErrors.slice(0, 2))}`);

    /* ------------------------------------------------------------------
       ★ 扫描版 PDF：上传 → 服务器抽不到文字 → **pdf.js 逐页渲染** → 视觉识别 → 预览
       ------------------------------------------------------------------ */
    const pdfStarted = await inTool(`
      const bin = atob(${JSON.stringify(scannedPdf.toString("base64"))});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const f = new w.File([arr], '扫描版.pdf', { type: 'application/pdf' });
      const dt = new w.DataTransfer();
      dt.items.add(f);
      const inp = w.document.getElementById('fileInput');
      inp.files = dt.files;
      inp.dispatchEvent(new w.Event('change'));
      return 'started';
    `);
    if (!String(pdfStarted).startsWith("started")) record("（准备）上传扫描版 PDF", false, JSON.stringify(pdfStarted));

    // 走到这里已经做过一次**图片**识别了：pdf.js 仍然不该被加载（只有 PDF 才需要它）
    const lazyAfterImage = await inTool(`
      const sc = w.document.querySelector('script[data-src="vendor/pdf.min.js"]');
      return { pdfScriptTag: !!sc, pdfLib: !!w.pdfjsLib };
    `);
    record("★懒加载②：做过图片识别之后**仍然没有**加载 pdf.js（只有 PDF 那条路才需要它）",
      lazyAfterImage?.pdfScriptTag === false && lazyAfterImage?.pdfLib === false,
      JSON.stringify(lazyAfterImage));

    let pdfPreview = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      pdfPreview = await inTool(`
        const ta = w.document.querySelector('[data-vision="0"]');
        const lbl = ta ? (ta.parentElement.querySelector('label') || {}).innerText : null;
        const sc = w.document.querySelector('script[data-src="vendor/pdf.min.js"]');
        return ta ? { text: ta.value, label: lbl, pdfjsLoaded: !!(sc && sc.dataset.loaded),
                      loaded: !!(w.pdfjsLib) } : null;
      `);
      if (pdfPreview) break;
    }
    record("★扫描版 PDF：**真的加载了本地 pdf.js**（vendor/pdf.min.js 已注入并 load 完成）",
      pdfPreview?.pdfjsLoaded === true && pdfPreview?.loaded === true,
      `script.loaded=${pdfPreview?.pdfjsLoaded} window.pdfjsLib=${pdfPreview?.loaded}`);
    record("★扫描版 PDF：逐页渲染后走识别，预览面板按**页**标注（第 1 页）",
      !!pdfPreview && /第 1 页/.test(String(pdfPreview.label ?? "")) && String(pdfPreview.text).length > 200,
      `label=${JSON.stringify(pdfPreview?.label)} 文本长度=${String(pdfPreview?.text ?? "").length}`);
    record("★扫描版 PDF：识别文本与桩返回一致（渲染出来的图确实被送去识别了）",
      String(pdfPreview?.text ?? "").slice(0, 40) === String(demoFull).slice(0, 40) &&
        String(pdfPreview?.label ?? "").length > 0,
      JSON.stringify(String(pdfPreview?.text ?? "").slice(0, 60)));

    const pdfAdopted = await inTool(`
      w.document.getElementById('btnVisionAdopt').click();
      return { result: w.document.getElementById('parseResult').innerText.slice(0, 120),
               pv: w.document.getElementById('visionPreview').innerHTML.length };
    `);
    record("★扫描版 PDF：确认后同样走通原有解析（解析成功 + 预览收起）",
      /解析成功/.test(String(pdfAdopted?.result ?? "")) && pdfAdopted?.pv === 0,
      `结果=${JSON.stringify(String(pdfAdopted?.result ?? "").slice(0, 80))} 面板=${pdfAdopted?.pv} `
        + `页面异常=${JSON.stringify(pageErrors.slice(0, 2))}`);

    /* ------------------------------------------------------------------
       ★★ 第十七批：识别失败**只重试那一页**（两条管线各验一次）
       ------------------------------------------------------------------
       为什么要在这里测：这个功能的核心保证是"**只重发失败的那几页**"，
       而"发了几次请求"只有真浏览器 + 计数桩才验得出来（纯函数测不到）。
       做法：让桩对第 3 次请求回 500 → 断言前 2 页成功、第 3 页失败、出现重试按钮
             → 点重试 → 断言**只多了一次请求**（第 1、2 页没有被重发）。 */

    // ---- (a) 图片/截图那条管线：失败的是第 3 张 ----
    await fetch(`http://127.0.0.1:${STUB_PORT}/__set`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(demoFull), failNth: 3, onlyFirst: true, failPage: 0 }),
    });
    const beforeVision = calls.length;

    const v3 = await inTool(`
      const mk = (name, color) => {
        const cv = w.document.createElement('canvas'); cv.width = 12; cv.height = 12;
        const g = cv.getContext('2d'); g.fillStyle = color; g.fillRect(0,0,12,12);
        const dataUrl = cv.toDataURL('image/png');
        const bin = atob(dataUrl.split(',')[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new w.File([arr], name, { type: 'image/png' });
      };
      const dt = new w.DataTransfer();
      dt.items.add(mk('第1页.png', '#111'));
      dt.items.add(mk('第2页.png', '#333'));
      dt.items.add(mk('第3页.png', '#555'));
      const inp = w.document.getElementById('visionInput');
      inp.files = dt.files;
      const n = inp.files.length;            // 派发前先数（app 处理完会把 input 清空，这是隐私设计）
      inp.dispatchEvent(new w.Event('change'));
      return 'dispatched:' + n;
    `);
    record("（准备）三张图一起提交（其中第 3 张会被桩拒绝一次）",
      String(v3) === "dispatched:3", JSON.stringify(v3));

    let vState = null, vBtn = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const s = await inTool(`
        const h = w.PaperAnalysisHooks;
        return { st: h ? h.visionState() : null,
                 btn: !!w.document.getElementById('btnVisionRetry'),
                 boxText: (w.document.getElementById('visionPreview').innerText || '').slice(0, 200) };
      `);
      if (s?.st && s.st.failed.length) { vState = s.st; vBtn = s.btn; break; }
    }
    record("★图片管线：一页失败**不再整批作废** —— 成功的 2 页留在结果里",
      vState?.ok === 2 && vState?.total === 3,
      JSON.stringify(vState));
    record("★图片管线：失败页被单独记下（下标 2 = 第 3 张），状态区给出「只重试这 1 页」",
      vState?.failed?.length === 1 && vState.failed[0].index === 2 && vBtn === true,
      `failed=${JSON.stringify(vState?.failed)} 按钮=${vBtn}`);

    const visionCallsBeforeRetry = calls.length;
    await inTool(`w.document.getElementById('btnVisionRetry').click(); return true;`);
    let vAfter = null;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const s = await inTool(`const h = w.PaperAnalysisHooks; return h ? h.visionState() : null;`);
      if (s && s.failed.length === 0 && s.ok === 3) { vAfter = s; break; }
      if (s) vAfter = s;
    }
    const visionRetryCalls = calls.length - visionCallsBeforeRetry;
    record("★图片管线：点「只重试这 1 页」后全部 3 页都成功",
      vAfter?.ok === 3 && vAfter?.failed?.length === 0,
      JSON.stringify(vAfter));
    record("★图片管线：重试**只发了 1 次请求**（另外 2 页没有被重发 = 没重复花钱）",
      visionRetryCalls === 1,
      `重试期间新增请求 ${visionRetryCalls} 次（期望 1；桩总请求 ${
        calls.length - beforeVision}）`);

    // ---- (b) 学校卷子那条管线：失败的是第 2 页（按 body.page 定位，桩看得见页码）----
    await inTool(`w.document.getElementById('btnSchoolClear')?.click(); return true;`);
    await fetch(`http://127.0.0.1:${STUB_PORT}/__set`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: String(demoFull), failNth: 0, failPage: 2 }),
    });
    const beforeSchool = calls.length;
    const s3 = await inTool(`
      const mk = (name, color) => {
        const cv = w.document.createElement('canvas'); cv.width = 12; cv.height = 12;
        const g = cv.getContext('2d'); g.fillStyle = color; g.fillRect(0,0,12,12);
        const dataUrl = cv.toDataURL('image/png');
        const bin = atob(dataUrl.split(',')[1]);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new w.File([arr], name, { type: 'image/png' });
      };
      const dt = new w.DataTransfer();
      dt.items.add(mk('卷1.png', '#111'));
      dt.items.add(mk('卷2.png', '#333'));
      dt.items.add(mk('卷3.png', '#555'));
      const inp = w.document.getElementById('schoolInput');
      inp.files = dt.files;
      const n = inp.files.length;            // 同上：派发前先数（app 之后会清空 input）
      inp.dispatchEvent(new w.Event('change'));
      return 'dispatched:' + n;
    `);
    record("（准备）三页卷子一起提交（第 2 页会被桩拒绝一次）",
      String(s3) === "dispatched:3", JSON.stringify(s3));

    let scState = null, scBtn = false, scText = "";
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const s = await inTool(`
        const h = w.PaperAnalysisHooks;
        return { st: h ? h.schoolState() : null,
                 btn: !!w.document.getElementById('btnSchoolRetry'),
                 txt: (w.document.getElementById('schoolPreview').innerText || '').slice(0, 200) };
      `);
      if (s?.st && s.st.failed.length) { scState = s.st; scBtn = s.btn; scText = s.txt; break; }
      if (i > 8 && !scState) scText = s?.txt ?? "";
    }
    record("★学校卷子管线：一页失败也**不再整批作废**（失败的正好是第 2 页）",
      scState?.failed?.length === 1 && scState.failed[0].index === 1,
      `failed=${JSON.stringify(scState?.failed)}`);
    record("★学校卷子管线：状态区给出「只重试这 N 页」按钮，并说明其它页已保留",
      scBtn === true && /只重试这\s*1\s*页/.test(scText),
      JSON.stringify(scText.slice(0, 120)));

    const schoolCallsBeforeRetry = calls.length;
    await inTool(`w.document.getElementById('btnSchoolRetry').click(); return true;`);
    let scAfter = null, scPreview = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const s = await inTool(`
        const h = w.PaperAnalysisHooks;
        return { st: h ? h.schoolState() : null,
                 preview: !!w.document.querySelector('#schoolPreview [data-q]') ||
                          /题目|考点|正确答案/.test(w.document.getElementById('schoolPreview').innerText || '') };
      `);
      if (s?.st && s.st.failed.length === 0) { scAfter = s.st; scPreview = s.preview; break; }
      if (s) scAfter = s.st;
    }
    const schoolRetryCalls = calls.length - schoolCallsBeforeRetry;
    record("★学校卷子管线：点重试后失败清零，且**重新出了预览**（收尾步骤没漏）",
      scAfter?.failed?.length === 0 && scPreview === true,
      `state=${JSON.stringify(scAfter)} 预览=${scPreview}`);
    record("★学校卷子管线：重试**只发了 1 次请求**（第 1、3 页没有重发）",
      schoolRetryCalls === 1,
      `重试期间新增请求 ${schoolRetryCalls} 次（期望 1；本批总请求 ${calls.length - beforeSchool}）`);

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
