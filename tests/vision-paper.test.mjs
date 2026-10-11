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

const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    // 控制口：让测试把"桩该返回的文本"换成工具自带的示例报告
    if (req.url === "/__set") {
      try { stubText = String(JSON.parse(raw).text ?? REPORT_TEXT); } catch { /* 忽略 */ }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, chars: stubText.length }));
      return;
    }
    let body = null;
    try { body = JSON.parse(raw); } catch { /* 保留 null */ }
    calls.push({ path: req.url, auth: req.headers.authorization ?? "", body });
    res.setHeader("content-type", "application/json");
    if (stubMode === "upstream500") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: "stub-vision-paper-boom" } }));
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
