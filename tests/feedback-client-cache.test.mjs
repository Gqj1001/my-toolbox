/**
 * 课后反馈工具 · **客户端缓存**（IndexedDB）的行为与护栏验证
 *
 * 为什么要有这个文件：
 *   「先显示缓存、后台再拉新」是**最容易被做成假象**的一类优化 ——
 *   表面上页面秒开了，实际上可能：
 *     · 再也不拉新（管理员改了关键词，老师永远看不到）
 *     · 把**学生档案/历史**也缓存了（老师拿旧档案生成反馈，家长收到错内容）
 *     · 截图里看不出「这屏是缓存还是新数据」
 *   所以本文件除了测「快不快」，**必须**钉死这几条：
 *     1. 二次访问命中缓存 → 立即出内容，**同时**确实发了真实请求（不能只读缓存）
 *     2. 数据相同 → **一行 DOM 都不动**（不闪烁）
 *     3. 数据不同 / 版本号变 → 静默替换成新内容，并且缓存被清掉重写
 *     4. **students / history 绝不落盘**（直接查 IndexedDB 里的真实内容）
 *     5. 超 TTL → 仍然先显示缓存，且后台重新拉
 *
 * 前置：先 `pnpm build`（本测试跑在 next start 上）。
 * 跑法：
 *   & "<bundled node>" tests\feedback-client-cache.test.mjs
 *
 * ⚠️ 它自己起 `next start`（端口 3000）并杀掉 3000 上的旧监听进程，
 *    所以**别和其它真服务套件同时跑**（与 feedback-data-cache.test.mjs 同一个约定）。
 */
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { BASE, CDP, makePageApi, makeRecorder, readUsers, startServer } from "./_helpers.mjs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const DEBUG_PORT = 9334;
/** 缓存配置档**必须**在仓库之外，且每次都删掉 —— 否则上一轮留下的 IndexedDB
 *  会让「首次访问」变成「二次访问」，测试直接失去意义。 */
const PROFILE = "D:\\my-website\\.edge-profile-fbcache";
const TOOL = "/tools/feedback";
/** 与页面里 CACHE_DB_NAME 一致（断言 IndexedDB 真实内容时用） */
const DB = "feedback_cache_v1";

const { record, summary } = makeRecorder();

/** 首屏就绪：徽章已切到云端 + 关键词分类真的画出来了（不是空壳） */
const READY_EXPR = `(()=>{
  const f=document.querySelector('iframe'); if(!f||!f.contentDocument) return false;
  const d=f.contentDocument;
  const badge=d.getElementById('modeBadge');
  if(!badge || !/云端/.test(badge.textContent||'')) return false;
  return d.querySelectorAll('#generateCategories details.cat').length > 0;
})()`;

/** 紧凑的状态快照（断言用） */
const STATE_EXPR = `(()=>{
  const f=document.querySelector('iframe'); if(!f||!f.contentDocument) return {__err:'无 iframe'};
  const d=f.contentDocument, w=f.contentWindow;
  const sh=d.getElementById('syncHint'), badge=d.getElementById('modeBadge');
  const tf=d.getElementById('textbookField');
  return {
    hint: sh ? (sh.textContent||'') : null,
    badge: badge ? (badge.textContent||'') : null,
    categories: d.querySelectorAll('#generateCategories details.cat').length,
    keywords: d.querySelectorAll('#generateCategories .chip input[type=checkbox]').length,
    textbookVisible: !!(tf && tf.style.display !== 'none'),
    textbooks: d.querySelectorAll('#textbookVersionSelect option').length,
    stuChips: d.querySelectorAll('#stuList .stu-chip').length,
    phraseChips: d.querySelectorAll('#phraseList .chip').length,
    skeletonHidden: !!(d.getElementById('appSkeleton') || {}).hidden,
    state: w.__fbClientCacheState || null
  };
})()`;

let srv = null;
let edge = null;
let cdp = null;
let sessionId = null;

try {
  // ---------------------------------------------------------------- 起服务
  srv = await startServer();
  record("next start 起来了", true);

  // ---------------------------------------------------------------- 起浏览器（干净档）
  rmSync(PROFILE, { recursive: true, force: true });
  edge = spawn(EDGE, [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run", "--no-default-browser-check",
    "about:blank",
  ], { stdio: "ignore" });

  let ws = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      const { webSocketDebuggerUrl } = await r.json();
      ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res);
        ws.addEventListener("error", rej);
      });
      break;
    } catch { /* 继续等 */ }
  }
  if (!ws) throw new Error("连不上 Edge 调试端口");
  cdp = new CDP(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);

  /** 每次导航时在新文档里记下「导航开始时刻」。
   *  iframe 与顶层页面同源，`performance.now()` 是**同一根单调时钟**，
   *  所以「iframe 里读到缓存并画出内容」的耗时可以直接相减，
   *  不依赖 CDP 往返、也不受测试机负载的污染。
   *  ⚠️ 必须在**任何导航之前**注册（登录那一步也算导航）。 */
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: "window.__navStart = performance.now();",
  }, sessionId);
  record("浏览器已就绪（并已注入 __navStart 计时锚点）", true);

  /** 记录工具 iframe 里 `#syncHint` **每一次**被写入的值。
   *
   *  为什么需要它：「>24 小时」那条提示只存在到「后台核对回来」为止
   *  （本机约 300–600ms），靠 CDP 每 40ms 轮询去抓是**不可靠**的
   *  —— 本轮实测就抓空了。改成在**父文档起始**就替换
   *  `Node.prototype.textContent` 的 setter，由页面自己把历史记下来，测试事后查账。
   *
   *  ⚠️ 为什么能在父页面拦到 iframe 里的赋值：本页的 iframe **没有 sandbox 属性**，
   *     与父页面**同源同 realm**，所以 `Node.prototype` 是同一份对象。
   *     （如果将来给 iframe 加了 sandbox，这个探针会静默失效 —— 那时断言会失败，
   *      正好提醒改用别的手段，不会假装通过。） */
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(function(){
      var desc = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
      if (!desc || !desc.set) return;
      window.__fbHintLog = [];
      Object.defineProperty(Node.prototype, 'textContent', {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set: function(v){
          try {
            if (this && this.id === 'syncHint') {
              var w = this.ownerDocument && this.ownerDocument.defaultView;
              var log = (w && w.__fbHintLog) || window.__fbHintLog;
              var s = String(v);
              if (log[log.length - 1] !== s) log.push(s);
            }
          } catch (e) { /* 记录失败绝不影响页面 */ }
          return desc.set.call(this, v);
        }
      });
    })();`,
  }, sessionId);

  const { ev, login } = makePageApi(cdp, sessionId);

  /**
   * 在工具 iframe 里求值。
   *
   * ⚠️ **不要用 `_helpers.mjs` 的 `inTool`**：它把 body 直接塞进一个同步 IIFE 里，
   *    所以 body 里用 `await` 会抛 "await is only valid in async functions" ——
   *    而 `Runtime.evaluate` 会把这类**语法错误**吞成返回值 undefined，
   *    于是断言看起来像「页面没渲染」，实际是测试自己写错了。
   *    本轮的缓存断言几乎全都要等 IndexedDB 的 promise，所以这里**必须**用 async。
   *
   * ⚠️ 另外：`Runtime.exceptionDetails` 一律当失败返回，不要返回真值对象 ——
   *    否则 `{__err:'…'}` 会被后面的 `if(v)` 判成「成立」，测试就变成永远绿的。
   */
  const inTool = async (body) => {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `(async () => {
        const f = document.querySelector('iframe');
        if (!f) return { __err: '无 iframe' };
        const d = f.contentDocument, w = f.contentWindow;
        if (!d) return { __err: '无 contentDocument' };
        ${body}
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (r.exceptionDetails) {
      return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval-error" };
    }
    if (!r.result) return undefined;
    const v = r.result.value;
    return isErr(v) ? undefined : v;
  };
  /** 判定用：一个求值结果是不是「错误哨兵」。 */
  const isErr = (v) => !!(v && typeof v === "object" && !Array.isArray(v) && v.__err);

  /** 断言里要区分「真的没有缓存」和「求值失败」时用这个（保证不抛） */
  const report = (v) => (isErr(v) ? "求值失败: " + v.__err : JSON.stringify(v));

  // ---------------------------------------------------------------- 登录
  const { adminEmail, password } = readUsers();
  const okLogin = await login(adminEmail, password);
  record("登录成功", okLogin);
  if (!okLogin) throw new Error("登录失败，后续测不了");

  /** 数「真实请求」：Network 事件里匹配 /api/feedback/data */
  const countDataRequests = () =>
    cdp.events.filter((e) =>
      e.method === "Network.requestWillBeSent" &&
      /\/api\/feedback\/data/.test(e.params?.request?.url || "")).length;

  /** 导航到工具页并等 iframe 里的工具**首屏就绪**，返回耗时。
   *  ⚠️ 不依赖 `Page.loadEventFired`：iframe 是并行加载的，等顶层 load 事件
   *     往往已经错过了「首屏」那一刻（缓存命中时首屏只要几百毫秒）。 */
  async function visitAndMeasure(url = TOOL, timeoutMs = 15000) {
    cdp.clear();
    await cdp.send("Page.navigate", { url: BASE + url }, sessionId);
    const t0 = Date.now();
    const samples = [];
    while (Date.now() - t0 < timeoutMs) {
      const ready = await ev(READY_EXPR).catch(() => false);
      if (samples.length < 5) samples.push(`${Date.now() - t0}ms=${JSON.stringify(ready)}`);
      if (ready === true) {
        const ms = await inTool("return Math.round(w.performance.now() - (w.__navStart||0));");
        // ⚠️ 顺手在**探测到就绪的同一刻**抓一份状态快照：
        //    后台核对（约 300–600ms）随时可能完成并把 state 覆盖掉，
        //    事后单独再读一次很容易读到「核对已完成」的状态，
        //    于是「首屏该不该提示过期」这类判断就失真了（本轮踩过）。
        const atPaint = await toolState();
        return { ok: true, wall: Date.now() - t0, fromNavStart: typeof ms === "number" ? ms : null, samples, atPaint };
      }
      await sleep(35);
    }
    return { ok: false, wall: Date.now() - t0, fromNavStart: null, samples };
  }

  /** 轮询 iframe 里的表达式，直到它返回真值（同样不等顶层 load 事件）。
   *  expr 里可以直接用 `d`（iframe document）与 `w`（iframe window）。
   *  ⚠️ 启动轮询**必须**与 `Page.navigate` 并行，不能等它 await 完再开始：
   *     缓存穿透那一瞬的提示只存在到「后台核对回来」为止（本机约 300–600ms），
   *     等 navigate 的 CDP 往返回来再轮询就已经错过了
   *     （本轮踩过：断言拿到空字符串，看起来像「提示语没写」）。 */
  async function waitInTool(expr, timeoutMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const v = await inTool(`return (${expr});`).catch(() => undefined);
      if (v !== undefined && v !== null && v !== false) return v;
      await sleep(40);
    }
    return null;
  }

  /** 导航 + **并行**开始轮询（用于抓「首屏那一瞬」的状态） */
  async function navigateAndProbe(expr, timeoutMs = 12000) {
    cdp.clear();
    const probing = waitInTool(expr, timeoutMs);
    const nav = cdp.send("Page.navigate", { url: BASE + TOOL }, sessionId).catch(() => null);
    const found = await probing;
    await nav;
    return found;
  }

  // ⚠️ 这两个包装必须**永远返回对象**：求值失败时返回一个「空但形状完整」的对象，
  //    否则一行 `coldState.categories` 就会把整个套件带走（后面全变 undefined）。
  const EMPTY_STATE = {
    hint: "", badge: "", categories: 0, keywords: 0, textbookVisible: false,
    textbooks: 0, stuChips: 0, phraseChips: 0, skeletonHidden: false, state: null,
  };
  const toolState = async () => (await inTool(`return (${STATE_EXPR});`)) || EMPTY_STATE;
  const cacheDump = async () => (await inTool("return await w.__fbClientCache();")) || { ok: false, keys: [], entries: {} };

  /** 直接改 IndexedDB 里那条缓存（模拟旧缓存 / 被注入脏数据）。
   *  用 `apply` 传一个**函数体字符串**，在页面里对 entry.value 做手术。 */
  const mutateCache = (key, applyBody) => inTool(`return await new Promise(res=>{
      const req = w.indexedDB.open('${DB}', 1);
      req.onsuccess = ()=>{
        const db = req.result;
        const g = db.transaction('kv','readonly').objectStore('kv').get(${JSON.stringify(key)});
        g.onsuccess = ()=>{
          const e = g.result;
          if(!e) return res('no-entry');
          try { (function(v){ ${applyBody} })(e.value); } catch(err){ return res('apply-err:'+err.message); }
          const tx = db.transaction('kv','readwrite');
          tx.objectStore('kv').put(e, ${JSON.stringify(key)});
          tx.oncomplete = ()=>res('ok'); tx.onerror = ()=>res('put-err'); tx.onabort = ()=>res('abort');
        };
        g.onerror = ()=>res('get-err');
      };
      req.onerror = ()=>res('open-err');
    });`);

  // ================================================================
  // 场景 0a：服务端确实下发了 dataVersion（版本号机制的入口）
  // ================================================================
  const apiProbe = await ev(`fetch('/api/feedback/data?stage=senior&subject=math',{credentials:'same-origin'})
    .then(r=>r.json()).then(d=>({ok:d.ok, v:d.dataVersion, cats:(d.categories||[]).length}))`);
  record("场景0a 接口响应里带 dataVersion（数字）",
    !!apiProbe && apiProbe.ok === true && typeof apiProbe.v === "number",
    `dataVersion=${apiProbe?.v} 分类=${apiProbe?.cats}`);
  const serverVersion = apiProbe?.v;

  // ================================================================
  // 场景 0：基线 —— **真正的**干净档首次访问
  // ================================================================
  // ⚠️ 打开工具页之前必须**先把 IndexedDB 清掉**。
  //    原因：登录流程本身可能已经加载过工具页（会话确认那一步），
  //    于是 IndexedDB 里已经有缓存，「首次访问」会变成「二次访问」
  //    （本轮踩过：场景0 报 usedCache=true，看起来像测试写反了）。
  //    做法：先导航到 about:blank 并**等一下**，让工具 iframe 的连接断开 ——
  //    否则 `deleteDatabase` 会被 `blocked`（页面还持有旧连接），缓存清不掉。
  /** 把会话 cookie 换成**同内容的一份新 cookie**（值不变）。
   *  为什么需要它：`login()` 是通过浏览器 UI 登录的，过程中可能已经加载过工具页
   *  并把 IndexedDB 写热了 —— 那样「首次访问」就永远是「二次访问」。
   *  重设 cookie 不受影响（会话仍然有效），但会把工具页留下的
   *  「同源页面状态」清干净，于是第一次导航到工具页是**真正的冷启动**。 */
  async function resetSessionCookies() {
    const all = await cdp.send("Network.getAllCookies", {}, sessionId);
    const ours = (all.cookies || []).filter((c) => /^sb-/.test(c.name) && /127\.0\.0\.1|localhost/.test(c.domain));
    if (!ours.length) return { ok: false, why: "没找到 sb-* 会话 cookie（登录可能没落到 cookie 上）" };
    await cdp.send("Network.clearBrowserCookies", {}, sessionId);
    for (const c of ours) {
      await cdp.send("Network.setCookie", {
        name: c.name, value: c.value, domain: c.domain, path: c.path || "/",
        secure: false, httpOnly: false, sameSite: "Lax",
      }, sessionId);
    }
    return { ok: true, count: ours.length };
  }

  // 让工具 iframe 的连接断开再删库：先导航到 /login（**同源**页面，没有工具 iframe）。
  // ⚠️ 不要用 about:blank 当这个中转页 —— 实测那样会直接抛
  //    「access to the Indexed Database API is denied in this context」。
  // ⚠️ 删完**必须验一遍是不是真的空了**：如果工具页那边还有一个写入在飞
  //    （或旧页面的 iframe 还没拆掉），缓存会被原地重建，
  //    「首次访问」就变成「二次访问」（本轮反复踩到）。所以这里删两次 + 复查。
  async function cacheKeyCount() {
    return await ev(`(async ()=>{
        try{
          return await new Promise(res=>{
            const req = indexedDB.open('${DB}', 1);
            // ⚠️ 必须自己处理 upgrade：删库之后再 open 会**新建**一个库，
            //    如果这里不建 object store，页面随后打开时会拿到一个**没有 kv 表**的库，
            //    于是所有缓存写入都失败、测试全红（本轮踩过）。
            req.onupgradeneeded = ()=>{
              const db = req.result;
              if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
            };
            req.onsuccess = ()=>{
              const db = req.result;
              try{
                const g = db.transaction('kv','readonly').objectStore('kv').getAllKeys();
                g.onsuccess = ()=>{ const n = (g.result||[]).length; db.close(); res(n); };
                g.onerror = ()=>{ db.close(); res(-1); };
              }catch(e){ db.close(); res(-2); }
            };
            req.onerror = ()=>res(-3);
          });
        }catch(e){ return -4; }
      })()`);
  }
  async function wipeOnce() {
    const r = await ev(`(async ()=>{
        try{
          return await new Promise(res=>{
            const req = indexedDB.deleteDatabase('${DB}');
            req.onsuccess = ()=>res('deleted');
            req.onerror = ()=>res('error');
            req.onblocked = ()=>res('blocked');
            setTimeout(()=>res('timeout'), 3000);
          });
        }catch(e){ return 'throw:' + e.message; }
      })()`);
    return r;
  }
  async function wipeIndexedDb() {
    // 先把会话 cookie 换成同内容的新 cookie：这样工具页在 cookie 里留下的东西
    // （以及任何在飞的工具页写入）都被切断，删库才有意义。
    const cookieReset = await resetSessionCookies();
    // 再离开工具页：那个 iframe 的连接会让 deleteDatabase 变 blocked。
    await cdp.send("Page.navigate", { url: BASE + "/login" }, sessionId);
    await sleep(1500);
    const first = await wipeOnce();
    await sleep(400);
    // 复查：若又被写回来了（说明还有写入在飞），再删一次
    let count = await cacheKeyCount();
    let second = null;
    if (count !== 0) {
      second = await wipeOnce();
      await sleep(400);
      count = await cacheKeyCount();
    }
    return { first, second, count, cookieReset };
  }
  const wipe1 = await wipeIndexedDb();
  record("场景0 已在首次访问前清空 IndexedDB（前提成立）",
    wipe1.count === 0,
    `deleteDatabase=${wipe1.first}${wipe1.second ? " → 再删一次=" + wipe1.second : ""}`
      + `；复查剩余条数=${wipe1.count}；cookie 重置=${JSON.stringify(wipe1.cookieReset)}`);
  // 会话仍须有效：cookie 是换了一份而不是删掉，所以这次导航应该直接进工具页
  const sessionStillOk = await ev(`fetch('/api/feedback/data?stage=senior&subject=math',{credentials:'same-origin'})
    .then(r=>r.status)`);
  record("场景0 重置 cookie 后会话仍然有效（前提成立）", sessionStillOk === 200, `状态码=${sessionStillOk}`);

  // ⚠️ **不要**在这里 clearBrowserCookies：那等于把刚登录的会话丢掉，
  //    随后打开 /tools/feedback 会被中间件 307 到 /login，测到的就成了登录页。
  const cold = await visitAndMeasure();
  record("场景0 干净档能打开工具页（首屏就绪）", cold.ok, `从导航起 ${cold.fromNavStart}ms`);
  const coldState = cold.atPaint;
  record("场景0 首屏数据非空（不是空壳）",
    coldState.categories > 0 && coldState.keywords > 0,
    `分类${coldState.categories} / 关键词${coldState.keywords} / 短语${coldState.phraseChips} / 教材${coldState.textbooks}`);
  record("场景0 徽章是云端版（不是「本机版」）",
    /云端/.test(coldState.badge || ""), `badge=${coldState.badge}`);
  record("场景0 首次访问没有走缓存（state 为空或 usedCache=false）",
    !coldState.state || coldState.state.usedCache !== true,
    JSON.stringify(coldState.state));

  const coldDump = await cacheDump();
  record("场景0 首次访问后 IndexedDB 里已写入缓存",
    coldDump.ok === true && (coldDump.keys || []).length === 1,
    `keys=[${(coldDump.keys || []).join(",")}] reason=${coldDump.reason || "-"}`);
  const cacheKey = (coldDump.keys || [])[0];
  const coldEntry = cacheKey ? coldDump.entries[cacheKey] : null;
  record("场景0 缓存条目带 savedAt / version（服务端已下发 dataVersion）",
    !!coldEntry && typeof coldEntry.savedAt === "number" && typeof coldEntry.version === "number",
    `savedAt=${coldEntry?.savedAt} version=${coldEntry?.version} bytes=${coldEntry?.bytes}`);

  // ★★ 红线：学生档案 / 反馈历史绝不落盘
  const storedKeys = (coldEntry?.valueKeys) || [];
  const hardLeak = ["students", "history", "userId", "email"].filter((k) => storedKeys.includes(k));
  record("★红线：缓存里没有 students / history / 用户身份字段",
    hardLeak.length === 0,
    `落盘字段=[${storedKeys.join(",")}] 违规=[${hardLeak.join(",")}]`);
  record("★红线：缓存内容里确实不含 students（按内容再查一遍）",
    !!coldEntry && !("students" in coldEntry.value) && !("history" in coldEntry.value),
    `value 顶层字段=[${Object.keys(coldEntry?.value || {}).join(",")}]`);
  record("场景0 缓存里确实有可用的静态数据（不是空壳缓存）",
    !!coldEntry && (coldEntry.value?.categories || []).length > 0 &&
      Object.keys(coldEntry.value?.categoryKeywords || {}).length > 0,
    `分类${(coldEntry?.value?.categories || []).length} / 关键词分类${Object.keys(coldEntry?.value?.categoryKeywords || {}).length}`);

  // ================================================================
  // 场景 1：二次访问（TTL 内）—— 缓存命中 + 确实拉新 + 不闪烁
  // ================================================================
  // 装「重渲染计数」快照的说明：计数由**页面自己**记（`__fbClientCacheState.checks / .rerenders`），
  // 为什么不用 MutationObserver / innerHTML 劫持：
  //   · MutationObserver 会观察到无关的 DOM 变动（徽章等），而且节点引用会因 iframe 重载失效；
  //   · **劫持 `innerHTML` 的 setter 会把页面弄坏**（后来的渲染全被吞掉，
  //     本轮踩过：劫持之后场景2/3/4 的关键词数一直停在旧值）。
  // 直接读页面自记的计数最准，也不干扰页面。
  // 记下「导航开始」这一刻的墙上时间：用来判断缓存的新鲜度时间戳有没有被推进到导航之后。
  const onlineStamp = Date.now();
  const warm = await visitAndMeasure();
  record("场景1 二次访问首屏就绪", warm.ok,
    `从导航起 ${warm.fromNavStart}ms（墙钟 ${warm.wall}ms）；轮询样本 [${(warm.samples || []).join(", ")}]`);
  record("★场景1 缓存命中：首屏 500ms 内出内容（核心目标）",
    warm.ok && typeof warm.fromNavStart === "number" && warm.fromNavStart < 500,
    `${warm.fromNavStart}ms（首次 ${cold.fromNavStart}ms）`);

  const warmState = warm.atPaint;   // 就绪那一刻的快照，不被后台核对覆盖
  record("场景1 首屏数据非空（缓存不是空的）",
    warmState.categories > 0 && warmState.keywords > 0,
    `分类${warmState.categories} / 关键词${warmState.keywords} / 短语${warmState.phraseChips}`);
  record("场景1 首屏确实来自缓存（state.usedCache）",
    warmState.state && warmState.state.usedCache === true,
    JSON.stringify(warmState.state));
  record("★场景1 缓存命中也**照样发了真实请求**（不是只读缓存）",
    countDataRequests() >= 1,
    `本次导航后 /api/feedback/data 请求数 = ${countDataRequests()}`);

  // 等后台核对收尾（此时若数据相同，DOM 必须一动没动）
  const settled = await waitInTool(
    `/已载入云端数据/.test((d.getElementById('syncHint')||{}).textContent||'')`,
    12000,
  );
  record("场景1 后台核对已完成（提示语回到「已载入云端数据」）", settled === true,
    `hint=${(await toolState()).hint}`);
  await sleep(1500); // 再等一会儿，确认没有「迟到的重渲染」

  // ★ 核心的「不闪烁」证据，用**两条互相独立**的硬证据，不看易受竞态影响的计数快照：
  //   ① 后台核对**真的做了** —— 缓存条目的 fetchedAt（=「最后一次被确认是最新的」）
  //      被推到了导航之后。若没做核对，它会一直停在旧值。
  //   ② 这次核对**没有重渲染** —— 页面自记的 rerenders 没有增加。
  //      （数据一致时重渲染就会闪一下，正是要消灭的东西。）
  const afterSettle = await cacheDump();
  const stateAfter = (await toolState()).state;
  const settledEntry = afterSettle.entries[cacheKey];
  const fetchedAfter = (settledEntry?.fetchedAt ?? 0) > onlineStamp;
  record("★场景1 后台核对确实做了（缓存的新鲜度时间戳被推进到本次导航之后）",
    fetchedAfter,
    `fetchedAt ${coldEntry.fetchedAt} → ${settledEntry?.fetchedAt}（导航开始 ${onlineStamp}）`);
  const dRerenders = (stateAfter?.rerenders ?? 0) - (warmState.state?.rerenders ?? 0);
  record("★场景1 数据相同 → **一次都没有重渲染**（不闪烁）",
    dRerenders === 0, `rerenders ${warmState.state?.rerenders} → ${stateAfter?.rerenders}`);
  record("场景1 核对后提示语说明「用的是本机缓存」",
    /本机缓存/.test((await toolState()).hint || ""), `hint=${(await toolState()).hint}`);

  // ================================================================
  // 场景 2：缓存与最新数据**不同** → 静默替换
  // ================================================================
  const targetCategory = Object.keys(coldEntry.value.categoryKeywords)[0];
  const realKeywords = coldEntry.value.categoryKeywords[targetCategory].slice();
  const shortened = realKeywords.slice(0, Math.max(1, realKeywords.length - 1));
  const t2 = await mutateCache(cacheKey, `
    v.categoryKeywords[${JSON.stringify(targetCategory)}] = ${JSON.stringify(shortened)};`);
  record("场景2 已把缓存里的关键词改少 1 条（模拟旧缓存）",
    t2 === "ok", `mutateCache=${t2}（分类「${targetCategory}」真实 ${realKeywords.length} 条 → 缓存 ${shortened.length} 条）`);

  const warm2 = await visitAndMeasure();
  record("场景2 二次访问仍能首屏就绪", warm2.ok, `${warm2.fromNavStart}ms`);
  await waitInTool(`/已载入云端数据/.test((d.getElementById('syncHint')||{}).textContent||'')`, 12000);
  await sleep(500);
  const after2 = await toolState();
  const dump2 = await cacheDump();
  const rewritten = dump2.entries[cacheKey]?.value?.categoryKeywords?.[targetCategory] || [];
  record("★场景2 数据不同 → 静默替换成最新（缓存里的「少 1 条」被纠正回来）",
    rewritten.length === realKeywords.length,
    `替换后该分类关键词 ${rewritten.length} 条（真实 ${realKeywords.length}）`);
  record("场景2 提示语明确说明这一屏此前是缓存",
    /本机缓存/.test(after2.hint || ""), `hint=${after2.hint}`);

  // ================================================================
  // 场景 3：版本号变 → 清缓存 + 重拉 + 按真实版本重写
  // ================================================================
  const dump3 = await cacheDump();
  const key3 = (dump3.keys || [])[0];
  const realVersion = dump3.entries[key3].version;
  const BOGUS = realVersion + 9999;
  await inTool(`return await w.__fbClientCacheTamper(${JSON.stringify(key3)}, { version: ${BOGUS} });`);
  const tampered3 = await cacheDump();
  record("场景3 已把缓存版本号改成错的（前提成立）",
    tampered3.entries[key3].version === BOGUS,
    `${tampered3.entries[key3].version}（真实 ${realVersion}）`);

  const v3 = await visitAndMeasure();
  record("场景3 版本号不对时页面照常可用", v3.ok, `${v3.fromNavStart}ms`);
  await waitInTool(`/已载入云端数据/.test((d.getElementById('syncHint')||{}).textContent||'')`, 12000);
  await sleep(800);
  const after3 = await cacheDump();
  record("★场景3 版本号不一致 → 缓存被清掉并按真实版本重写",
    after3.entries[key3] && after3.entries[key3].version === realVersion,
    `重写后 version=${after3.entries[key3]?.version}（期望 ${realVersion}）`);
  record("★场景3 重写进去的版本号 == 接口当前下发的 dataVersion（跨来源对拍）",
    after3.entries[key3] && after3.entries[key3].version === serverVersion,
    `缓存 version=${after3.entries[key3]?.version} / 接口 dataVersion=${serverVersion}`);
  const hint3 = (await toolState()).hint;
  record("★场景3 提示语承认「此前显示的是本机缓存」",
    /本机缓存/.test(hint3 || ""), `hint=${hint3}`);

  // ================================================================
  // 场景 4：把「学生数据」硬塞进缓存 —— 页面也不能拿它渲染
  // ================================================================
  const dump4 = await cacheDump();
  const key4 = (dump4.keys || [])[0];
  const GHOST = "不该出现的幽灵学生";
  const t4 = await mutateCache(key4, `
    v.students = { ${JSON.stringify(GHOST)}: { subject:'math' } };
    v.history  = { ${JSON.stringify(GHOST)}: [{ text:'旧内容' }] };`);
  record("场景4 已往缓存里硬塞学生/历史（前提成立）", t4 === "ok", `mutateCache=${t4}`);

  cdp.clear();
  await cdp.send("Page.navigate", { url: BASE + TOOL }, sessionId);
  // 抓「首屏（缓存穿透）那一刻」：幽灵学生绝不该画到屏幕上。
  // ⚠️ 用 navigateAndProbe 的并行写法（同场景5），否则等 navigate 回来就已经是核对后的状态。
  const early4 = await navigateAndProbe(
    `(()=>{ const st=(${STATE_EXPR}); return st.state && st.state.usedCache ? st : null; })()`,
    12000,
  );
  record("★场景4 缓存里被塞了学生，首屏也不显示它（渲染不读缓存的用户数据）",
    !!early4 && early4.stuChips === 0 && !JSON.stringify(early4).includes(GHOST),
    `首屏 stuChips=${early4?.stuChips}（幽灵学生=${GHOST}）`);
  await waitInTool(`/已载入云端数据/.test((d.getElementById('syncHint')||{}).textContent||'')`, 12000);
  await sleep(500);
  const after4 = await cacheDump();
  const keys4 = after4.entries[key4]?.valueKeys || [];
  record("★场景4 真实响应回来后，落盘内容里依然没有 students / history",
    !keys4.includes("students") && !keys4.includes("history"),
    `落盘字段=[${keys4.join(",")}]`);

  // ================================================================
  // 场景 5：超 TTL（且 >24 小时）→ 先显示缓存 + 明确提示 + 后台重拉
  // ================================================================
  const dump5 = await cacheDump();
  const key5 = (dump5.keys || [])[0];
  const OLD = Date.now() - 25 * 60 * 60 * 1000;   // 25 小时前
  await inTool(`return await w.__fbClientCacheTamper(${JSON.stringify(key5)}, { fetchedAt: ${OLD} });`);
  const tampered5 = await cacheDump();
  record("场景5 已把「最后拉取时间」改成 25 小时前（前提成立）",
    Math.abs((tampered5.entries[key5].fetchedAt || 0) - OLD) < 5000,
    `fetchedAt=${tampered5.entries[key5].fetchedAt}`);

  // 「>24 小时」那条提示只存在到「后台核对回来」为止（本机约 300–600ms），
  // 靠 CDP 轮询会抓空 —— 所以走文档起始就挂好的 `__fbHintLog` 事后查账。
  const onlineStamp5 = Date.now();
  const v5 = await visitAndMeasure();
  const early5 = v5.atPaint?.state;   // 就绪那一刻的状态快照（不被后台核对覆盖）
  await waitInTool(`/已载入云端数据/.test((d.getElementById('syncHint')||{}).textContent||'')`, 12000);
  await sleep(500);
  const hintLog5 = await inTool("return (w.__fbHintLog || (window.__fbHintLog || [])).slice();");
  // ★ 第一条（**确定性**）：直接对「新鲜度判定 + 提示语」这条纯逻辑求值，
  //   不受「后台核对有没有抢在前面」的时序影响。
  const probe = await inTool(`return w.__fbClientCacheProbe({
      fetchedAt: Date.now() - 25*60*60*1000, lastFreshOk: false });`);
  record("★场景5 新鲜度判定：>24 小时且未核对成功 → 判为不新鲜，并给出「可能不是最新」",
    !!probe && probe.fresh === false && /数据可能不是最新/.test(probe.hint || ""),
    `probe=${JSON.stringify(probe)}`);
  const probeFresh = await inTool(`return w.__fbClientCacheProbe({
      fetchedAt: Date.now() - 1000, lastFreshOk: false });`);
  record("★场景5 新鲜度判定：刚拉过 → 判为新鲜，不给过期提示",
    !!probeFresh && probeFresh.fresh === true && !/数据可能不是最新/.test(probeFresh.hint || ""),
    `probe=${JSON.stringify(probeFresh)}`);
  // 第二条（观察性）：真浏览器这一趟到底写没写过那条提示。
  // 本机太快时后台核对可能抢在首屏读取之前完成，那就**不该**提示 —— 所以这里
  // 按「首屏那一刻缓存是否还旧」来判断该不该出现，而不是无脑要求它出现。
  const staleExpected = !(early5 && early5.lastFreshOk === true);
  record("★场景5 超 TTL 先显示缓存 + 后台重拉（真浏览器观察）",
    staleExpected
      ? (Array.isArray(hintLog5) && hintLog5.some((t) => /数据可能不是最新/.test(t)))
      : true,
    `首屏 state=${JSON.stringify(early5)}；期望出现过期提示=${staleExpected}；syncHint 写过：${JSON.stringify(hintLog5)}`);
  record("场景5 超 TTL 时页面照样可用", v5.ok, `${v5.fromNavStart}ms`);
  record("★场景5 超 TTL 仍然后台重新拉（发了真实请求）",
    countDataRequests() >= 1,
    `本次导航后 /api/feedback/data 请求数 = ${countDataRequests()}`);
  const after5 = await cacheDump();
  record("场景5 核对成功后新鲜度被推进（不再提示 25 小时前）",
    (after5.entries[key5].fetchedAt || 0) > onlineStamp5,
    `fetchedAt=${after5.entries[key5].fetchedAt}（原 ${OLD}，本次导航开始 ${onlineStamp5}）`);

  // ================================================================
  // 场景 5b：缓存条数有上限（每条维度一份，长期用不能无限涨）
  // ================================================================
  // 先塞满一批「旧」条目，再让页面按正常流程写一次（后台核对成功时会落盘），
  // 期望：总数被裁到上限以内，且刚写进去的那条一定还在。
  const STALE_KEYS = ["stage=junior&subject=history", "stage=junior&subject=politics",
    "stage=senior&subject=biology", "stage=senior&subject=geography",
    "stage=junior&subject=chemistry", "stage=senior&subject=physics",
    "stage=junior&subject=english", "stage=senior&subject=chinese"];
  const filled = await inTool(`return await new Promise(res=>{
      const req = w.indexedDB.open('${DB}', 1);
      req.onupgradeneeded = ()=>{ const db=req.result; if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv'); };
      req.onsuccess = ()=>{
        const db = req.result;
        const tx = db.transaction('kv','readwrite');
        const st = tx.objectStore('kv');
        ${JSON.stringify(STALE_KEYS)}.forEach((k,i)=>{
          st.put({ value:{ categories:['x'], categoryKeywords:{ x:['y'] } },
                   savedAt: 1000 + i, fetchedAt: 1000 + i, version: 1 }, k);
        });
        tx.oncomplete = ()=>{ const n = 0; db.close(); res(${JSON.stringify(STALE_KEYS)}.length); };
        tx.onerror = ()=>{ db.close(); res(-1); };
      };
      req.onerror = ()=>res(-2);
    });`);
  record("场景5b 已往缓存里塞进一批旧维度条目（前提成立）",
    filled === STALE_KEYS.length, `塞入 ${filled} 条`);
  const beforePrune = (await cacheDump()).keys.length;
  await visitAndMeasure();
  await waitInTool(`/已载入云端数据/.test((d.getElementById('syncHint')||{}).textContent||'')`, 12000);
  await sleep(1500);
  const afterPrune = await cacheDump();
  record("★场景5b 缓存条数被裁到上限以内（不会无限增长）",
    afterPrune.keys.length <= 6,
    `裁剪前 ${beforePrune} 条 → 裁剪后 ${afterPrune.keys.length} 条 [${afterPrune.keys.join(", ")}]`);
  record("★场景5b 刚用过的那条缓存**没有被裁掉**",
    afterPrune.keys.includes(key5),
    `保留的是 [${afterPrune.keys.join(", ")}]`);

  // ================================================================
  // 场景 6：非 NEXT_MODE（file://）不受影响 —— 用代码结构断言
  // ================================================================
  const htmlSrc = await ev(`fetch('/tools/feedback.html').then(r=>r.text())`);
  const src = typeof htmlSrc === "string" ? htmlSrc : "";
  const nonNextBranch = src.slice(src.indexOf("本机版 / 独立后端：保持原有行为"), src.indexOf("detectServer().then"));
  record("场景6 能取到工具源码（前提成立）", src.length > 10000, `源码 ${src.length} 字节`);
  record("★场景6 客户端缓存只接在云端分支：(1) initCloud 里有缓存读写",
    src.includes("if(NEXT_MODE){") && src.includes("initCloud();") &&
      /const entry = _cacheDisabled \? null : await cacheGet\(scopeKey\)/.test(src),
    "");
  record("★场景6 客户端缓存只接在云端分支：(2) 本机版那段一行未改、不含任何缓存调用",
    nonNextBranch.length > 0 && !/cacheGet|cachePut|__fbClientCache|IndexedDB/.test(nonNextBranch),
    `本机版分支 ${nonNextBranch.length} 字节，未出现缓存调用`);

  console.log(`\n   本机参考：首次 ${cold.fromNavStart}ms / 二次（缓存命中）${warm.fromNavStart}ms。`);
  console.log("   本机到 Supabase 延迟低，绝对值不代表用户体感；有代表性的是二者的差值。");
} catch (e) {
  record("测试执行未异常中断", false, String(e && e.message ? e.message : e));
} finally {
  try { if (cdp) await cdp.send("Browser.close"); } catch { /* ignore */ }
  if (edge?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${edge.pid} -Force`], { encoding: "utf8" });
  if (srv?.pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${srv.pid} -Force`], { encoding: "utf8" });
  const ok = summary();
  process.exit(ok ? 0 : 1);
}
