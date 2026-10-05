// 辅导方案「模板化 Word 导出」浏览器端验证 + DEMO 导出
//
//   1. 页面里两个导出按钮都在（主按钮=模板化，次级=旧版 HTML）
//   2. 外部脚本都加载成功（template-data / docx-builder / report-template）
//   3. 用 DEMO/预设生成方案 → 真正在浏览器里跑一次模板导出 → 拿到 docx 字节
//   4. 把字节写成文件，供人工用 Word 打开对比
//   5. 页面无 JS 异常；AI 按钮不受影响
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { startServer, startBrowser, makePageApi, makeRecorder, readUsers, sleepMs } from "./_helpers.mjs";

/* Node 侧加载同一套模块（用于把 payload 落盘成 docx） */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOD_DIR = join(ROOT, "public/tools/math-plan");
const asBrowserScript = (f) => readFileSync(f, "utf8")
  .replace(/if \(typeof module === 'object' && module\.exports\)/g, "if (false)");
const nodeCtx = { console, Math, JSON, Array, Object, String, Number, Uint8Array, TextEncoder, TextDecoder,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64") };
nodeCtx.self = nodeCtx; nodeCtx.window = nodeCtx;
vm.createContext(nodeCtx);
for (const f of ["template-data.js", "js/docx-builder.js", "js/report-template.js"]) {
  vm.runInContext(asBrowserScript(join(MOD_DIR, f)), nodeCtx, { filename: f });
}
const T = nodeCtx.MathPlanTemplateData;
const RT = nodeCtx.MathPlanReportTemplate;

const { adminEmail, password } = readUsers();
const { record, summary } = makeRecorder();

const OUT_DIR = "D:/my-website/.tmp-planning-samples/demo-out";
// 文件名带版本号：避免人工正在 Word 里打开旧文件时写入失败（EBUSY）
const OUT_FILE = OUT_DIR + "/DEMO-辅导方案-模板导出-v5-修正辅导时间.docx";

let srv = null, edge = null;
try {
  srv = await startServer();
  const b = await startBrowser(9470, "D:/my-website/.edge-profile-mp-export");
  edge = b.edge;
  const { cdp, sessionId } = b;
  const { ev, goto, login } = makePageApi(cdp, sessionId);

  const pageErrors = [];
  cdp.ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      const ex = d?.exception ?? {};
      const desc = typeof ex.description === "string" ? ex.description : "";
      const abortedXhr = desc === "Object" && Array.isArray(ex.preview?.properties)
        && ex.preview.properties.some((p) => p.name === "setRequestHeader" || p.name === "readyState");
      if (!abortedXhr) pageErrors.push(`${String(d?.text)} ${desc.slice(0, 200)}`);
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const args = (m.params.args ?? []).map((a) => (a.description ?? a.value ?? a.type ?? "").toString()).join(" ").slice(0, 200);
      if (!(/readyState|overrideMimeType/.test(args) && args.length < 120)) pageErrors.push("console.error: " + args);
    }
  });

  const loggedIn = await login(adminEmail, password);
  record("管理员登录成功", loggedIn);
  if (!loggedIn) throw new Error("登录失败");

  await goto("/tools/math-plan.html", 9000);
  const inDoc = (body) => ev(`(() => { const doc=document; try { ${body} } catch(e){ return {__err:String(e&&e.message||e)}; } })()`);

  for (let i = 0; i < 24; i++) {
    if (await inDoc(`return !!doc.getElementById('btnGen')`)) break;
    await sleepMs(500);
  }

  /* ---- 1. 三个外部脚本是否都加载 ---- */
  const libs = await inDoc(`
    return {
      tpl: typeof window.MathPlanTemplateData,
      db: typeof window.DocxBuilder,
      rt: typeof window.MathPlanReportTemplate,
      placeholders: window.MathPlanTemplateData ? window.MathPlanTemplateData.PLACEHOLDERS.length : 0,
      lessonRows: window.MathPlanTemplateData ? window.MathPlanTemplateData.LESSON_ROWS : 0,
      hooks: typeof window.MathPlanHooks,
    };
  `);
  record("template-data.js 已加载（278 个占位符 / 67 样板行）",
    libs.tpl === "object" && libs.placeholders === 278 && libs.lessonRows === 67,
    JSON.stringify(libs));
  record("docx-builder.js 已加载", libs.db === "object", libs.db);
  record("report-template.js 已加载", libs.rt === "object", libs.rt);
  record("测试钩子已就位", libs.hooks === "object", libs.hooks);

  /* ---- 2. 两个按钮 ---- */
  const btns = await inDoc(`
    const main = doc.getElementById('btnDoc'), legacy = doc.getElementById('btnDocLegacy');
    const cs = legacy ? getComputedStyle(legacy) : null;
    return {
      mainText: main ? main.textContent.trim() : null,
      legacyText: legacy ? legacy.textContent.trim() : null,
      mainPrimary: main ? main.classList.contains('primary') : null,
      legacySmaller: legacy && main ? (parseFloat(cs.fontSize) < parseFloat(getComputedStyle(main).fontSize)) : null,
    };
  `);
  record("主按钮文案「⬇ 导出 Word（模板）」且为主样式",
    btns.mainPrimary === true && /导出 Word（模板）/.test(String(btns.mainText)),
    `${btns.mainText} primary=${btns.mainPrimary}`);
  record("次级按钮文案「⬇ 导出 Word（旧版）」且字号更小",
    /导出 Word（旧版）/.test(String(btns.legacyText)) && btns.legacySmaller === true,
    `${btns.legacyText} smaller=${btns.legacySmaller}`);

  /* ---- 3. 生成方案 ---- */
  const preset = await inDoc(`const b=doc.querySelector('.preset button[data-preset="gap"]'); if(!b) return {err:'无 gap 预设'}; b.click(); return 'ok';`);
  if (preset && preset.err) record("找到预设按钮", false, preset.err);
  await sleepMs(3000);
  let ready = await inDoc(`return { rows: doc.querySelectorAll('#goalsBody [data-goal]').length }`);
  if (!ready || !ready.rows) {
    await inDoc(`const b=doc.getElementById('btnGen'); if(b) b.click(); return 'ok';`);
    await sleepMs(2500);
    ready = await inDoc(`return { rows: doc.querySelectorAll('#goalsBody [data-goal]').length }`);
  }
  record("方案已渲染（逐次课表有教学目标单元格）", !!ready && ready.rows > 0, JSON.stringify(ready));

  const counts = await inDoc(`return window.MathPlanHooks.counts();`);
  record("AI 按钮仍在（未被本次改动影响）", counts.aiButtons === 2, JSON.stringify(counts));

  /* ---- 4. 浏览器里真正跑一次模板导出 ---- */
  const built = await inDoc(`
    const r = window.MathPlanHooks.buildBytes();
    if(!r) return { err: 'buildBytes 返回 null' };
    return { len: r.bytes.length, rows: r.rows, warnings: r.warnings, head: r.bytes.slice(0,2) };
  `);
  record("浏览器里模板导出成功", !built.__err && !built.err && built.len > 0,
    built.err || built.__err || `${built.len} 字节 / ${built.rows} 次课`);
  record("导出字节是合法 ZIP（PK 头）", Array.isArray(built.head) && built.head[0] === 80 && built.head[1] === 75,
    JSON.stringify(built.head));
  if (built.warnings && built.warnings.length) console.log("     导出提示:", built.warnings.join(" ; "));

  /* ---- 5. 落盘供人工对比 ----
     ⚠ 不要把 45 万字节的数组从浏览器传回 Node：CDP 的 returnByValue 传大数组会失败
     （built.bytes 会变成 undefined，且不报错）。改为两步：
       ① 浏览器里 buildBytes() 证明"前端能导出"（并拿到长度校验）
       ② 只把 payload（几十 KB 的文本）取回来，在 Node 里用同一份模块重新 build → 写文件
     这样落盘的文件与浏览器导出的内容一致（同一份模板 + 同一个 payload）。 */
  const payload = await inDoc(`
    const p = window.MathPlanHooks.buildPayload();
    return p ? JSON.parse(JSON.stringify(p)) : null;
  `);
  record("能从页面取回导出 payload（DOM 现取的数据）",
    !!payload && Array.isArray(payload.rows) && payload.rows.length > 0,
    payload ? `${payload.rows.length} 行 / method ${String(payload.method).length} 字` : String(payload));

  if (payload && built.len > 0) {
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
    const res = RT.build(payload, { template: T });
    writeFileSync(OUT_FILE, Buffer.from(res.blob));
    record("DEMO docx 已写出到磁盘", existsSync(OUT_FILE),
      `${OUT_FILE}（${res.blob.length} 字节 / ${res.rows} 次课）`);
    // 与浏览器里导出的长度对比，确认两边一致
    record("Node 侧重建的字节数与浏览器导出一致",
      res.blob.length === built.len, `浏览器 ${built.len} / Node ${res.blob.length}`);
  }

  /* ---- 6. 点一次主按钮，确认走的是模板导出（不抛异常即算通过） ---- */
  await inDoc(`doc.getElementById('btnDoc').click(); return 'clicked';`);
  await sleepMs(1200);
  const toastText = await inDoc(`return doc.getElementById('toast') ? doc.getElementById('toast').textContent : ''`);
  record("点主按钮有反馈提示", String(toastText).length > 0, String(toastText).slice(0, 70));

  if (pageErrors.length) {
    console.log("     页面错误详情:");
    pageErrors.slice(0, 6).forEach((p) => console.log("       " + p));
  }
  record("页面无真实 JS 异常", pageErrors.length === 0, `${pageErrors.length} 条`);

  try { await cdp.send("Browser.close"); } catch { /* ignore */ }
} catch (e) {
  record("测试执行未异常中断", false, e.message);
  console.error("测试异常:", e.message);
} finally {
  if (edge) { try { edge.kill(); } catch { /* ignore */ } }
  if (srv) { try { srv.kill(); } catch { /* ignore */ } }
}

const pass = summary();
process.exit(pass ? 0 : 1);
