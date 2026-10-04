// 测试公共工具：认证、CDP 连接、生产服务器启动
// 目的：把「登录后间歇性丢会话」这类 flakiness 收敛到一处
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export const BASE = "http://127.0.0.1:3000";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const NODE_BIN = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT_BIN = "D:\\my-website\\my-toolbox\\node_modules\\next\\dist\\bin\\next";
const PROJECT = "D:\\my-website\\my-toolbox";

export const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export function readEnv() {
  const lines = readFileSync(`${PROJECT}/.env.local`, "utf8").split(/\r?\n/);
  return {
    SUPABASE_URL: lines.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL=")).split("=")[1].trim(),
    ANON_KEY: lines.find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_ANON_KEY=")).split("=").slice(1).join("=").trim(),
  };
}

export function readUsers() {
  const info = JSON.parse(readFileSync(`${PROJECT}/.test-users.json`, "utf8"));
  return {
    adminEmail: info.users.find((u) => u.email.startsWith("rolea-")).email,
    userEmail: info.users.find((u) => u.email.startsWith("roleb-")).email,
    password: info.password,
  };
}

export class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), rej(new Error("timeout " + method))), 30000);
    });
  }
  waitForEvent(method, t = 20000) {
    const hit = () => this.events.find((e) => e.method === method);
    if (hit()) return Promise.resolve(hit().params);
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const tick = () => { if (hit()) return res(hit().params); if (Date.now() - t0 > t) return rej(new Error("timeout")); setTimeout(tick, 100); };
      tick();
    });
  }
  clear() { this.events = []; }
}

/** 启动生产服务器（测试必须跑在 next start 上：dev 模式 HMR 被拦会导致 React 不挂载）*/
export async function startServer() {
  const pid = spawnSync("powershell", ["-NoProfile", "-Command",
    "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess"],
    { encoding: "utf8" }).stdout.trim();
  if (pid) spawnSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force`], { encoding: "utf8" });
  await sleepMs(2000);
  const srv = spawn(NODE_BIN, [NEXT_BIN, "start", "-p", "3000"], { cwd: PROJECT, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    await sleepMs(500);
    try { if ((await fetch(`${BASE}/login`)).status === 200) break; } catch { /* 等待 */ }
  }
  return srv;
}

/** 启动无头 Edge + 打开一个 target，返回 { cdp, sessionId, edge } */
export async function startBrowser(port, profile) {
  const edge = spawn(EDGE, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "about:blank",
  ], { stdio: "ignore" });
  let cdp = null;
  for (let i = 0; i < 40; i++) {
    await sleepMs(500);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const { webSocketDebuggerUrl } = await r.json();
      const ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
      cdp = new CDP(ws);
      break;
    } catch { /* 等待 */ }
  }
  if (!cdp) throw new Error("无法连接 Edge 调试端口");
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  return { cdp, sessionId, edge };
}

/** 建一套页面操作工具 */
export function makePageApi(cdp, sessionId) {
  const ev = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
    return r.result.value;
  };
  const goto = async (p, w = 4000) => {
    cdp.clear();
    await cdp.send("Page.navigate", { url: BASE + p }, sessionId);
    await cdp.waitForEvent("Page.loadEventFired").catch(() => {});
    await sleepMs(w);
  };
  /** 工具页 iframe 内查询 */
  const inTool = (body) => ev(`(() => {
    const f=document.querySelector('iframe'); if(!f) return {__err:'无 iframe'};
    const doc=f.contentDocument; const w=f.contentWindow; if(!doc) return {__err:'无 contentDocument'};
    try { ${body} } catch(e){ return {__err:String(e && e.message || e)}; }
  })()`);

  /**
   * 健壮登录：清 cookie → 确认登录表单出现 → 提交 → 确认会话真的建立
   * 返回 true 表示已登录且 /api/feedback/data 返回 200
   */
  const login = async (email, password) => {
    cdp.clear();
    await cdp.send("Network.clearBrowserCookies", {}, sessionId);
    await goto("/login", 2000);
    // 残留会话可能把 /login 直接跳走，再清一次
    if ((await ev("location.pathname")) !== "/login") {
      await cdp.send("Network.clearBrowserCookies", {}, sessionId);
      await goto("/login", 2000);
    }
    for (let i = 0; i < 40; i++) {
      if (await ev(`!!document.querySelector('form input[name="email"]')`).catch(() => false)) break;
      await sleepMs(250);
    }
    if (!(await ev(`!!document.querySelector('form input[name="email"]')`))) return false;
    await ev(`(() => {
      const f=document.querySelector("form");
      const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
      const em=f.querySelector('input[name="email"]'), pw=f.querySelector('input[name="password"]');
      d.set.call(em, ${JSON.stringify(email)}); em.dispatchEvent(new Event("input",{bubbles:true}));
      d.set.call(pw, ${JSON.stringify(password)}); pw.dispatchEvent(new Event("input",{bubbles:true}));
      return true; })()`);
    await sleepMs(400);
    await ev(`document.querySelector("form").requestSubmit(), true`);
    for (let i = 0; i < 60; i++) { await sleepMs(500); if ((await ev("location.pathname")) !== "/login") break; }
    await sleepMs(1200);
    // 确认会话
    for (let i = 0; i < 6; i++) {
      const st = await ev(`fetch('/api/feedback/data?stage=senior&subject=math',{credentials:'same-origin'}).then(r=>r.status)`);
      if (st === 200) return true;
      await sleepMs(800);
    }
    return false;
  };

  return { ev, goto, inTool, login };
}

/** 简易断言器 */
export function makeRecorder() {
  const results = [];
  const record = (name, pass, detail) => {
    results.push({ name, pass });
    console.log(`${pass ? "PASS" : "FAIL"} | ${name}${detail ? ` | ${detail}` : ""}`);
  };
  const summary = () => {
    const passed = results.filter((r) => r.pass).length;
    console.log("\n=== SUMMARY ===");
    console.log(`${passed}/${results.length} passed`);
    return passed === results.length && results.length > 0;
  };
  return { record, summary, results };
}
