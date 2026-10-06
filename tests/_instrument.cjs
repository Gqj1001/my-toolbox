/**
 * 出网计数插桩（只给测试用，不进生产代码）。
 *
 * 用法：起服务时用 `NODE_OPTIONS=--require=<本文件>` 预加载，
 * 它会把进程内所有发往 Supabase 的 fetch 记下来，并开一个小端口（默认 4599）
 * 供测试脚本查询：
 *   GET  /stats  → { total, rows, byTable }
 *   POST /reset  → 清零
 *
 * 为什么要这么做：本项目到 Supabase 的绝对延迟没有代表性
 * （本机约 120ms、用户环境 400–500ms），**调用次数才是有效指标**（见 docs/perf-notes.md）。
 */
const COUNTER_PORT = Number(process.env.INSTRUMENT_PORT || 4599);

let total = 0;
let rows = []; // 每条 [表名或路径, 完整 URL]
let byTable = {};
let collecting = false;

const realFetch = globalThis.fetch;

function isSupabase(url) {
  return typeof url === "string" && /supabase\.(co|in)/.test(url);
}

/** 从 PostgREST 的 URL 里认出「打的是哪张表」：/rest/v1/<table>?... */
function labelOf(url) {
  const m = url.match(/\/rest\/v1\/([^?/]+)/);
  if (m) return m[1];
  const a = url.match(/\/auth\/v1\/([^?/]+)/);
  if (a) return "auth:" + a[1];
  return "other";
}

globalThis.fetch = function countedFetch(input, init) {
  let url = "";
  try {
    url = typeof input === "string" ? input : (input && input.url) || String(input);
  } catch {
    url = "";
  }
  if (collecting && isSupabase(url)) {
    total += 1;
    const label = labelOf(url);
    rows.push(label);
    byTable[label] = (byTable[label] || 0) + 1;
  }
  return realFetch.call(this, input, init);
};

require("node:http")
  .createServer((req, res) => {
    if (req.url === "/stats") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ total, rows, byTable }));
      return;
    }
    if (req.url === "/reset") {
      total = 0;
      rows = [];
      byTable = {};
      collecting = true;
      res.end("ok");
      return;
    }
    if (req.url === "/start") {
      collecting = true;
      res.end("ok");
      return;
    }
    res.statusCode = 404;
    res.end("no");
  })
  .listen(COUNTER_PORT, "127.0.0.1");

console.log(`[instrument] 出网计数已就绪，端口 ${COUNTER_PORT}`);
