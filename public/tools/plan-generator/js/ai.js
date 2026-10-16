/**
 * 辅导方案生成器 · AI 生成「教学目标」初稿（客户端一侧）
 * ==========================================================================
 * 这个文件只干三件事：
 *   ① **组包**：把当前方案的上下文 + 要处理的行，组成服务端要的形状（纯函数，可单测）
 *   ② **落地**：把返回的目标**安全地**贴回对应行（纯函数，可单测）
 *   ③ **发请求**：`fetch('/api/plan-generator/ai')`（**只有这一步碰网络**）
 *
 * ⚠️ 三条铁口径（跟服务端提示词是配套的）：
 *   1. **行数契约**：返回条数必须等于请求条数，否则整批丢弃 —— 宁可不填，
 *      也绝不把 A 模块的目标贴到 B 模块上（老师很难发现这种错位）。
 *   2. **不覆盖老师已经写过的目标**：默认只填空的行；老师要覆盖得自己点「全部重写」。
 *      （AI 是来"打草稿"的，不是来"改老师的稿"的。）
 *   3. 拿不到就**明说**（会员到期/没配 Key/超时各给一句人话），**绝不静默留空**。
 *
 * ⚠️ 这里**没有任何学科内容**：学科名、教材、模块都从科目包与当前方案里取。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlanGenAI = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var ENDPOINT = "/api/plan-generator/ai";
  /** 一次最多送多少条（与服务端 MAX_ROWS 对齐；多了就分批） */
  var MAX_ROWS_PER_CALL = 40;

  /* ======================================================================
     ① 组包（纯函数）
     ====================================================================== */

  /**
   * 把一行模块整理成服务端要的形状。
   * @param row  当前方案里的一行（来自引擎的 mkRow，含 name/term/lv/chapters/content/goal）
   * @param pack 科目包（要它的 stages 表来把 stage key 翻成中文名）
   */
  function rowPayload(row, pack) {
    var r = row || {};
    var stages = (pack && pack.stages) || [];
    var stageName = "";
    for (var i = 0; i < stages.length; i++) {
      if (stages[i].key === r.stage) { stageName = stages[i].name; break; }
    }
    var tags = r.tags || [];
    return {
      name: String(r.name || ""),
      term: String(r.term || ""),
      lv: (r.lv == null ? 2 : r.lv),
      stageName: stageName || String(r.stageName || ""),
      chapters: (r.chapters || []).slice(),
      content: String(r.content || ""),
      // 含学生实验的模块，目标里要出现实验相关分点（提示词里有对应说明）
      hasExperiment: tags.indexOf("实验") >= 0 || /实验/.test(String(r.name || ""))
    };
  }

  /**
   * 组一次请求的 body。
   * @param opts { pack, subjectName, grade, bandName, score, targetScore, totalHours, rows }
   */
  function buildPayload(opts) {
    var o = opts || {};
    var pack = o.pack || {};
    return {
      subject: String(pack.key || ""),
      subjectName: String(o.subjectName || pack.name || ""),
      stage: String(pack.stage || ""),
      grade: o.grade == null ? "" : String(o.grade),
      bandName: o.bandName == null ? "" : String(o.bandName),
      score: o.score == null ? "" : o.score,
      targetScore: o.targetScore == null ? "" : o.targetScore,
      totalHours: o.totalHours == null ? "" : o.totalHours,
      rows: (o.rows || []).map(function (r) { return rowPayload(r, pack); })
    };
  }

  /** 哪些行需要 AI 写（默认：只补空的；force=true 时全部） */
  function planRows(rows, opts) {
    var force = !!(opts && opts.force);
    var only = opts && opts.onlyIndexes;
    var out = [];
    (rows || []).forEach(function (r, i) {
      if (only && only.length && only.indexOf(i) < 0) return;
      var hasGoal = String(r && r.goal ? r.goal : "").trim().length > 0;
      if (!force && !only && hasGoal) return;      // 老师写过了，不碰
      out.push(i);
    });
    return out;
  }

  /** 把一批索引切成不超过 MAX_ROWS_PER_CALL 的几批（保持顺序） */
  function chunk(indexes, size) {
    var n = size || MAX_ROWS_PER_CALL;
    var out = [];
    for (var i = 0; i < (indexes || []).length; i += n) out.push(indexes.slice(i, i + n));
    return out;
  }

  /* ======================================================================
     ② 落地（纯函数）
     ====================================================================== */

  /** 结果码 → 给老师看的一句人话（**唯一来源**，界面不要自己拼句子） */
  function messageOf(status, serverError) {
    if (status === 401) return "请先登录，再使用 AI 生成。";
    if (status === 403) return "AI 生成初稿是会员专属功能；" + (serverError || "请先开通会员。");
    if (status === 503) return serverError || "服务端还没配置 AI Key，请联系管理员。";
    if (status === 413) return serverError || "一次送的内容太多了，请少选一些再试。";
    if (status === 400) return serverError || "请求内容有问题，请重新生成方案后再试。";
    if (status === 502) return serverError || "AI 服务暂时不可用，请稍后重试。";
    return serverError || "AI 生成失败，请稍后重试。";
  }

  /**
   * 校验并整理返回的目标数组。
   * @returns {{ok:boolean, goals?:string[], error?:string}}
   */
  function normalizeGoals(data, expectCount) {
    if (!data || typeof data !== "object") return { ok: false, error: "AI 返回格式不对，请重试。" };
    if (data.ok !== true) return { ok: false, error: String(data.error || "AI 生成失败，请重试。") };
    if (!Array.isArray(data.goals)) return { ok: false, error: "AI 返回格式不对，请重试。" };
    // ⚠️ 行数契约在客户端**再校验一次**：服务端已经校验过，但这里多一道不亏 ——
    //    错位的目标贴到别的模块上，老师基本发现不了。
    if (data.goals.length !== expectCount) {
      return { ok: false, error: "AI 返回的条数与模块数不一致（" + data.goals.length + " ≠ " + expectCount + "），已放弃这次结果以免贴错。" };
    }
    var goals = [];
    for (var i = 0; i < data.goals.length; i++) {
      var g = String(data.goals[i] == null ? "" : data.goals[i]).replace(/\s+/g, " ").trim();
      if (!g) return { ok: false, error: "AI 返回里有空条目（第 " + (i + 1) + " 条），已放弃这次结果。" };
      goals.push(g);
    }
    return { ok: true, goals: goals };
  }

  /**
   * 把一批目标贴回指定的行（**不改原数组**，返回新的 rows）。
   * @param rows     原行数组
   * @param indexes  这批目标对应哪些行的下标（与 goals 一一对应）
   * @param goals    目标文本
   * @returns {{rows:Array, applied:number}}
   */
  function applyGoals(rows, indexes, goals) {
    var out = (rows || []).map(function (r) { return Object.assign({}, r); });
    var applied = 0;
    for (var i = 0; i < (indexes || []).length; i++) {
      var idx = indexes[i];
      if (idx < 0 || idx >= out.length) continue;
      if (goals[i] == null) continue;
      out[idx].goal = String(goals[i]);
      applied++;
    }
    return { rows: out, applied: applied };
  }

  /* ======================================================================
     ③ 发请求（唯一碰网络的地方）
     ====================================================================== */

  /** 本站部署才开云（双击 HTML / 放到别的服务器上跑 → 不联网，给老师一句明说） */
  function isHosted() {
    try {
      return location.protocol === "http:" || location.protocol === "https:";
    } catch (e) { return false; }
  }

  /**
   * 调一次接口。
   * @returns {Promise<{ok:boolean, goals?:string[], error?:string, status?:number}>}
   */
  async function callOnce(payload) {
    if (!isHosted()) {
      return { ok: false, error: "双击打开的版本连不上本站的 AI 服务，请从网站上进入本工具。" };
    }
    var res, text;
    try {
      res = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      text = await res.text();
    } catch (e) {
      return { ok: false, error: "网络请求失败，请检查网络后重试。", status: 0 };
    }
    var data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!res.ok) {
      var serverError = data && data.error ? String(data.error) : "";
      return { ok: false, error: messageOf(res.status, serverError), status: res.status };
    }
    var n = normalizeGoals(data, (payload.rows || []).length);
    if (!n.ok) return { ok: false, error: n.error, status: res.status };
    return { ok: true, goals: n.goals, status: res.status };
  }

  /**
   * 生成一批（内部会按 MAX_ROWS_PER_CALL 切批；任一批失败就整次失败并说明）。
   * @param opts 见 buildPayload，另加 { indexes }（要处理哪些行；不给则自动挑"还没写的"）
   * @returns {Promise<{ok, rows, applied, error, batches}>}
   */
  async function generate(opts) {
    var o = opts || {};
    var rows = o.rows || [];
    var indexes = o.indexes && o.indexes.length ? o.indexes.slice() : planRows(rows, o);
    if (!indexes.length) {
      return { ok: true, rows: rows.slice(), applied: 0, batches: 0, error: "" };
    }
    var groups = chunk(indexes);
    var current = rows.slice();
    var applied = 0;
    for (var g = 0; g < groups.length; g++) {
      var idxs = groups[g];
      var payload = buildPayload({
        pack: o.pack, subjectName: o.subjectName, grade: o.grade, bandName: o.bandName,
        score: o.score, targetScore: o.targetScore, totalHours: o.totalHours,
        rows: idxs.map(function (i) { return current[i]; })
      });
      var r = await callOnce(payload);
      if (!r.ok) {
        // 已经成功的批次**保留**（不整批回滚：回滚等于白花已经付钱的那次调用）
        return { ok: false, rows: current, applied: applied, batches: groups.length, error: r.error, status: r.status };
      }
      var ap = applyGoals(current, idxs, r.goals);
      current = ap.rows;
      applied += ap.applied;
    }
    return { ok: true, rows: current, applied: applied, batches: groups.length, error: "" };
  }

  /* ======================================================================
     导出（测试要用到全部纯函数）
     ====================================================================== */
  return {
    ENDPOINT: ENDPOINT,
    MAX_ROWS_PER_CALL: MAX_ROWS_PER_CALL,
    // 纯函数
    rowPayload: rowPayload,
    buildPayload: buildPayload,
    planRows: planRows,
    chunk: chunk,
    messageOf: messageOf,
    normalizeGoals: normalizeGoals,
    applyGoals: applyGoals,
    // 网络
    isHosted: isHosted,
    callOnce: callOnce,
    generate: generate
  };
}));
