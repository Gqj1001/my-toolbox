/**
 * 回归 Group B（需要真服务的 6 套 + 自带服务 1 套）——**必须独占 3000 端口**
 *
 * 为什么要有这个脚本：这 7 套里有 6 套需要外部已起好的服务，另 1 套会**自己起服务并杀掉 3000**。
 * 手工顺序容易搞错，而两边同时用 3000 会得到**假红**（真实案例：2026-10 本轮，
 * 两个 runner 抢 3000，`ai-thinking-mode` 被打成 0/11 —— 它起服务时带了假 AI_KEY，
 * 结果请求被**别人的**服务回答，回来 503「未配置 AI Key」）。
 *
 * 用法：& <bundled node> tests\_run-ui-suites.mjs   （工作目录必须是仓库根）
 * 输出：控制台实时打一份；每套另存一份完整日志到 .tmp-planning-samples/ui-suite-logs/
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const NODE = "C:\\Users\\郭庆杰\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe";
const NEXT = "node_modules\\next\\dist\\bin\\next";
const BASE = "http://127.0.0.1:3000";
const CWD = "D:\\my-website\\my-toolbox";
const LOG_DIR = "D:\\my-website\\.tmp-planning-samples\\ui-suite-logs";

/** 需要「外面先起好服务」的套件 */
const DEFAULT_NEED_SERVER = [
  "step7-ui.test.mjs",
  "verify-checklist.mjs",
  "paper-regression.test.mjs",
  "paper-score-ui.test.mjs",
  "math-plan-ai-sections.test.mjs",
  "math-plan-export-ui.test.mjs",
];
/** 自己起服务（会先杀掉 3000）的套件 —— 必须放在最后，且要先停掉我们的服务 */
const DEFAULT_OWN_SERVER = ["math-plan-ai-vip-path.test.mjs"];

// 允许临时指定要跑的套件（调试单套时用）：只传文件名 = 当作「需要外部服务」那一组。
//   & <node> tests\_run-ui-suites.mjs paper-regression.test.mjs
//   & <node> tests\_run-ui-suites.mjs tests\paper-regression.test.mjs   ← 两种写法都要认
// ⚠️ 统一去掉 `tests\` 前缀，因为下面 spawn 时会自己拼 `tests\`（本轮就踩到过
//    `tests\tests\xxx` 这种路径）。
const argv = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("-"))
  .map((a) => a.replace(/^\.?[\\/]?tests[\\/]/i, ""));
const NEED_SERVER = argv.length ? argv : DEFAULT_NEED_SERVER;
const OWN_SERVER = argv.length ? [] : DEFAULT_OWN_SERVER;

const ps = (cmd) => spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).stdout.trim();
const listeners = () => ps("(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess");

const waitFree = async (secs) => {
  for (let i = 0; i < secs * 2; i++) {
    if (!listeners()) return true;
    await sleep(500);
  }
  return !listeners();
};
const waitUp = async (secs) => {
  for (let i = 0; i < secs * 2; i++) {
    try { if ((await fetch(`${BASE}/login`)).status === 200) return true; } catch { /* 等 */ }
    await sleep(500);
  }
  return false;
};

/** 跑一套：实时回显 + 落日志，返回 { code, summary, fails } */
const run = (file) => new Promise((resolve) => {
  console.log(`\n########## ${file} ##########`);
  // ⚠️ 日志名只用**文件名部分**：临时传 `tests\xxx.test.mjs` 进来时，
  //    直接用原串会拼出 `...\ui-suite-logs\tests\xxx.log` → ENOENT（本轮踩到）。
  const logPath = `${LOG_DIR}\\${file.split(/[\\/]/).pop().replace(/\.mjs$/, "")}.log`;
  const out = createWriteStream(logPath);
  const p = spawn(NODE, [`tests\\${file}`], { cwd: CWD, stdio: ["ignore", "pipe", "pipe"] });
  const summary = { line: "", fails: [] };
  const onLine = (line) => {
    out.write(line + "\n");
    if (/^(PASS|FAIL) \|/.test(line)) console.log("  " + line);
    else if (/SUMMARY|passed|通过/.test(line)) console.log("  " + line);
    if (line.includes("FAIL |")) summary.fails.push(line);
    // ⚠️ 各套的汇总行格式**不统一**：多数是 `N/M passed`，
    //    而 `verify-checklist.mjs` 是老格式 `=== 验证清单 18/18 通过 ===`。
    //    只认 `passed` 会把它误判成「不干净」（2026-10 本轮踩到）。
    const m = line.match(/(\d+)\s*\/\s*(\d+)\s*(?:passed|通过)/);
    if (m) summary.line = `${m[1]}/${m[2]}`;
  };
  const feed = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) if (line.trim()) onLine(line);
  };
  p.stdout.on("data", feed);
  p.stderr.on("data", feed);
  p.on("exit", (code) => { out.end(); console.log(`  → exit=${code}  ${summary.line || "(无 SUMMARY)"}  日志：${logPath}`);
    resolve({ file, code, summary: summary.line, fails: summary.fails, logPath }); });
});

const results = [];
const summarize = () => {
  console.log("\n\n================ GROUP B SUMMARY ================");
  for (const r of results) console.log(`${r.file}  →  exit=${r.code}  ${r.summary || "(该套不打印 N/M 汇总行，看 exit)"}`);
  // ⚠️ 判「干净」以 **exit code** 为准：这些套件的失败路径都会 `process.exit(1)`。
  //    汇总行只是给人看的，格式还不统一（见 run() 里的注释），不能当唯一依据。
  const bad = results.filter((r) => r.code !== 0);
  console.log(bad.length ? `❌ 有 ${bad.length} 套退出码非 0` : "✅ 全部干净（exit=0）");
  for (const r of results) for (const f of r.fails) console.log("  FAIL → " + f);
  console.log(`日志目录：${LOG_DIR}`);
};

try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }

// ---------- 0. 先等 3000 空出来（另一个 runner 可能还在用） ----------
console.log("等待 3000 端口空出来…");
if (!(await waitFree(1800))) {
  console.log("⚠️ 3000 端口一直被别人占着，放弃（避免把别人的服务当成自己的，得到假红）");
  process.exit(3);
}

// ---------- 1. 起一次服务，跑需要外部服务的 6 套 ----------
console.log("启动 next start -p 3000 …");
const srv = spawn(NODE, [NEXT, "start", "-p", "3000"], { cwd: CWD, stdio: "ignore" });
if (!(await waitUp(120))) {
  console.log("❌ 服务没起来");
  try { srv.kill(); } catch { /* ignore */ }
  process.exit(4);
}
await sleep(2000);
for (const f of NEED_SERVER) results.push(await run(f));

// ---------- 2. 停掉我们的服务（next start 会派生真正的监听进程，必须按端口 KILL），
//             再让自带服务的套件自己起 ----------
const killPort3000 = () => ps(
  "(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).OwningProcess | " +
  "ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }");
try { srv.kill(); } catch { /* ignore */ }
killPort3000();
if (!(await waitFree(120))) console.log("⚠️ 3000 没释放，最后一套可能受污染");
for (const f of OWN_SERVER) results.push(await run(f));

summarize();
// 收尾：确保不留下服务
killPort3000();
process.exit(0);
