/**
 * 辅导方案生成器 · 纯算法引擎（学科无关）
 * ==========================================================================
 * 这个文件里**没有任何学科内容**：学科的全部信息（模块、章节、难度、建议课时、
 * 复习阶段、学段）都从「科目包」（`subjects/*.js`）读进来。加一个学科 = 加一份
 * 科目包文件，**这个文件一行都不用改**。
 *
 * 三条硬口径（用户 2026-10 拍板，别再改回去）：
 *   1. **一行 = 一个模块**（不是"一行 = 一次课 2h"）—— 本文件只产出「模块行」，
 *      **不存在**把课时拆成 2 小时一次课的函数（math-plan 的 `buildLessons()` 刻意不抄）。
 *   2. **课时写模块总课时，保留一位小数**（4.5 / 7.5 / 10.5 都要原样活着）。
 *   3. **课时总和必须等于老师填的总课时**（差额补给排课最多的模块），宁可差 0.1，
 *      也绝不让附件3 的合计行对不上。
 *
 * 为什么单独一个文件：这样"模块取舍对不对、课时分摊对不对"可以在 Node 里**纯函数**
 * 断言，不用开浏览器（见 `tests/plan-generator-engine.test.mjs`）。
 *
 * ⚠️ 别在这里读 DOM、别读 localStorage、别发请求 —— 它是可被单测直接 require 的纯逻辑。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlanGenEngine = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ======================================================================
     0. 小数工具
     ----------------------------------------------------------------------
     ⚠️ 全部课时走**整数「分」**做加减（1 小时 = 10 分），只在出口除以 10。
     浮点数在这里是真会咬人的：0.1+0.2 = 0.30000000000000004，
     而附件3 的合计行会把 `0.30000000000000004` 原样印出来。
     ====================================================================== */

  /** 小时 → 整数分（一位小数精度，四舍五入） */
  function toTenths(hours) {
    const n = Number(hours);
    if (!isFinite(n)) return 0;
    return Math.round(n * 10);
  }

  /** 整数分 → 小时（一位小数） */
  function fromTenths(t) {
    return Math.round(t) / 10;
  }

  /** 取一位小数（对外统一出口） */
  function round1(hours) {
    return fromTenths(toTenths(hours));
  }

  /** 求和（一位小数，无浮点尾巴） */
  function sumHours(list) {
    return fromTenths(list.reduce((a, h) => a + toTenths(h), 0));
  }

  const MIN_HINT = 0.5;      // 建议课时缺失时的兜底值（半天）
  const MIN_ROW_HOURS = 1;   // 每一行至少 1 课时（"0 课时"由模块包显式给 hoursHint:0 表达）
  const MAX_ROW_FACTOR = 2;  // 单模块上限 = 建议课时 × 2（防止一个模块把预算吃光）

  /* ======================================================================
     1. 学段 / 年级 / 模块顺序
     ====================================================================== */

  /** 年级先后（数字越小越靠前）。认不出来的一律排最后，且**保持原顺序**（稳定排序）。 */
  const GRADE_RANK = {
    "初一": 1, "七年级": 1, "七年级上": 1, "七年级下": 1,
    "初二": 2, "八年级": 2, "八年级上": 2, "八年级下": 2,
    "初三": 3, "九年级": 3, "九年级上": 3, "九年级下": 3,
    "高一": 10, "高一上": 10, "高一下": 11,
    "高二": 12, "高二上": 12, "高二下": 13,
    "高三": 20, "高三上": 20, "高三下": 21,
  };

  function gradeRank(g) {
    const key = String(g == null ? "" : g).trim();
    if (GRADE_RANK[key] != null) return GRADE_RANK[key];
    return 900;   // 认不出来 → 最后（不报错，宁可排后面也不把老师填的年级当非法）
  }

  /** 模块的教材册次（term）→ 先后。同样认不出来排最后。 */
  const TERM_RANK = [
    ["必修一", 1], ["必修1", 1], ["必修 1", 1], ["八年级上", 1], ["八上", 1], ["七年级上", 1],
    ["必修二", 2], ["必修2", 2], ["必修 2", 2], ["八年级下", 2], ["八下", 2], ["七年级下", 2],
    ["必修三", 3], ["必修3", 3], ["必修 3", 3], ["九年级", 3], ["九全", 3],
    ["选择性必修一", 4], ["选择性必修1", 4], ["选必一", 4], ["选必1", 4],
    ["选择性必修二", 5], ["选择性必修2", 5], ["选必二", 5], ["选必2", 5],
    ["选择性必修三", 6], ["选择性必修3", 6], ["选必三", 6], ["选必3", 6],
    ["二轮", 90], ["三轮", 91], ["收口", 92],
  ];

  function termRank(term) {
    const key = String(term == null ? "" : term).trim();
    if (!key) return 500;
    for (const [name, r] of TERM_RANK) {
      if (key.indexOf(name) >= 0) return r;
    }
    return 500;
  }

  /**
   * 模块在「教材顺序」上的位置。
   * · 模块包显式给了 `seq` 就用它（最可控，推荐）
   * · 否则按 term 的册次 + 数组下标（同一册内保持模块包里的书写顺序）
   */
  function seqOf(pack, mod, index) {
    if (mod && typeof mod.seq === "number" && isFinite(mod.seq)) return mod.seq;
    const tr = termRank(mod && mod.term);
    const base = tr >= 90 ? 1000 + tr : tr * 100;
    return base + (index || 0) * 0.01;
  }

  /** 带顺序号的模块列表（不改原对象） */
  function indexedModules(pack) {
    const mods = (pack && pack.modules) || [];
    return mods.map((m, i) => Object.assign({}, m, { _index: i, _seq: seqOf(pack, m, i) }));
  }

  /** 按教材顺序排（稳定） */
  function sortBySyllabus(list) {
    return list
      .map((m) => ({ m, i: m._index }))
      .sort((a, b) => (a.m._seq - b.m._seq) || (a.i - b.i))
      .map((x) => x.m);
  }

  /**
   * 这个年级能排哪些模块。
   * · 科目包用 `grades: { '高三': [...] }` 显式给 → 用它
   * · 也可以用 `order`（旧名，兼容）
   * · 都没给 → 全部模块（宁多勿少）
   * ⚠️ 返回的是**并集**：grades 表里每个年级列出的模块合起来（老师换年级就有对应模块）。
   */
  function modulesForGrade(pack, grade) {
    const all = indexedModules(pack);
    const table = (pack && (pack.grades || pack.order)) || {};
    const keys = Object.keys(table);
    if (!keys.length) return all;

    const key = String(grade == null ? "" : grade).trim();
    let ids = table[key];

    // 直接命中不到就往前找最接近的（例：填「高三」而表里只有「高三上/高三下」）
    if (!ids && key) {
      const near = keys
        .filter((k) => k.indexOf(key) === 0 || key.indexOf(k) === 0)
        .sort((a, b) => gradeRank(a) - gradeRank(b) || a.length - b.length)[0];
      if (near) ids = table[near];
    }
    if (!ids) return all;

    const want = {};
    ids.forEach((id) => { want[id] = true; });
    return all.filter((m) => want[m.id]);
  }

  /* ======================================================================
     2. 打分（决定"先排哪些模块"）
     ----------------------------------------------------------------------
     骨架照抄 math-plan 的 pickModules()（已验证的评分思路），但**读的是科目包的字段**，
     且没有写死的模块 id（那边 m41/m43-45 是数学专属，这里用 must / tags 表达）。
     ====================================================================== */

  /** 档位：按科目包给的 bands（每科满分不同，数学 150 分制、物理 100 分制，不能写死） */
  function bandOf(pack, score) {
    const bands = (pack && pack.bands) || [];
    const s = Number(score);
    if (!isFinite(s)) return bands.length ? bands[bands.length - 1] : { key: 1, name: "—" };
    // bands 按 min 从高到低写（如 85 / 60 / 0）
    const sorted = bands.slice().sort((a, b) => (b.min || 0) - (a.min || 0));
    for (const b of sorted) {
      if (s >= (b.min || 0)) return b;
    }
    return sorted.length ? sorted[sorted.length - 1] : { key: 1, name: "—" };
  }

  /** 档位 key 归一：1 = 补基础（最低档）… n = 最高档。bands 通常按从高到低写 3/2/1。 */
  function bandKeyOf(pack, score) {
    const b = bandOf(pack, score);
    return b && b.key != null ? b.key : 1;
  }

  /**
   * 单个模块的排序分（越大越先排）。
   * 读的字段：`lv`（1 基础 / 2 中档 / 3 高阶）、`tags`、`topic`、`must`。
   */
  function scoreModule(mod, opts) {
    const lv = Number(mod.lv) || 2;
    const band = opts.band;                 // 1..3
    const focus = opts.focus || "auto";
    const tags = Array.isArray(mod.tags) ? mod.tags : [];
    let s = 0;

    // 档位 × 难度：低分段先基础，高分段先难题
    if (band <= 1) s += ({ 1: 30, 2: 24, 3: 6 })[lv] || 0;
    else if (band === 2) s += ({ 1: 26, 2: 32, 3: 14 })[lv] || 0;
    else s += ({ 1: 16, 2: 30, 3: 34 })[lv] || 0;

    // 内容侧重
    const effFocus = focus === "auto"
      ? (band <= 1 ? "base" : band === 2 ? "mid" : "hard")
      : focus;
    if (effFocus === "base") s += ({ 1: 20, 2: 8, 3: -16 })[lv] || 0;
    if (effFocus === "mid") s += ({ 1: 8, 2: 20, 3: 6 })[lv] || 0;
    if (effFocus === "hard") s += ({ 1: -6, 2: 16, 3: 26 })[lv] || 0;
    if (effFocus === "all") s += 4;

    if (tags.indexOf("高频") >= 0) s += 5;
    if (tags.indexOf("送分题") >= 0) s += 6;
    if (tags.indexOf("必开") >= 0) s += 8;
    if (mod.must) s += 25;                                   // 必开模块必须进
    if (opts.weakTopics && (opts.weakTopics[mod.topic] || opts.weakTopics[mod.id] || opts.weakTopics[mod.name])) s += 18;
    if (opts.linked && opts.linked[mod.id]) s += 12;          // 前面模块的前置（科目包可声明）
    return s;
  }

  /* ======================================================================
     3. 选模块（预算感知的贪心）
     ----------------------------------------------------------------------
     规则：
       · 已完成的模块直接剔除（`must:true` 豁免 —— 语义是"无论学校复习没复习，这次都要排"）
       · 按分数从高到低纳入，但**只纳入还塞得下的**（每个模块至少 MIN_ROW_HOURS）
       · 若"必开模块的最小课时加起来"已经超过总课时 → 照排，并给一条 over 提示（不静默砍）
     ====================================================================== */

  function selectModules(pack, opts) {
    const o = opts || {};
    const totalT = toTenths(o.totalHours);
    const done = {};
    (o.done || []).forEach((id) => { done[id] = true; });

    let pool = modulesForGrade(pack, o.grade).slice();
    const required = pool.filter((m) => m.must || (Array.isArray(m.tags) && m.tags.indexOf("必开") >= 0));
    const optional = pool.filter((m) => required.indexOf(m) < 0);

    // 已完成的剔除（必开豁免）
    const keptOptional = optional.filter((m) => !done[m.id]);
    const removedDone = optional.filter((m) => done[m.id]).map((m) => ({ id: m.id, name: m.name }));

    // 排序：分数优先；同分按教材顺序（保证结果可复现，测试才钉得住）
    const scored = keptOptional
      .map((m) => ({ m, s: scoreModule(m, {
        band: o.band != null ? o.band : bandKeyOf(pack, o.score),
        focus: o.focus,
        weakTopics: o.weakTopics,
        linked: o.linked,
      }) }))
      .sort((a, b) => (b.s - a.s) || (a.m._seq - b.m._seq));

    const minT = toTenths(MIN_ROW_HOURS);
    /* 预算是有限的，而"每行 1 课时"是下限 —— 只看下限会**选进一堆模块却排不满**：
       实测（本轮真踩到）总课时 28 时，按"1 课时/模块"能选满 25 个模块，
       但配平时每行有上限（建议课时 × 2），最后只落地 25 课时，剩下 3 课时没地方放。
       所以选模块时按"这一行大概要占多少"估：建议课时的 0.5 倍（夹在 [1, 上限] 之间）。 */
    const weightOf = (m) => {
      const cap = Math.max(minT, hintTenths(m) * MAX_ROW_FACTOR);
      return Math.min(cap, Math.max(minT, Math.round(hintTenths(m) / 2)));
    };
    const reqMinT = required.reduce((a, m) => a + weightOf(m), 0);
    const overBudget = reqMinT > totalT && totalT >= 0;

    let roomT = totalT - reqMinT;
    if (roomT < 0) roomT = 0;

    const chosen = [];
    const droppedForBudget = [];
    for (const x of scored) {
      const need = weightOf(x.m);
      if (roomT >= need) {
        chosen.push(x.m);
        roomT -= need;
      } else {
        // 塞不下就跳过它、继续看后面的 —— **不 break**：断掉会让"轻但分高"的模块也被丢掉
        droppedForBudget.push({ id: x.m.id, name: x.m.name });
      }
    }

    // 输出顺序：教材顺序（老师看表要按课本走，而不是按分数高低跳来跳去）
    const finalList = sortBySyllabus(required.concat(chosen));

    return {
      modules: finalList,
      dropped: droppedForBudget,
      removedDone,
      overBudget,
      requiredCount: required.length,
      /** 老师填的总课时大概够排几个模块（按各模块"预计占用"估算，仅供提示文案用） */
      capacity: (() => {
        let n = 0, used = 0;
        for (const x of scored) {
          const need = weightOf(x.m);
          if (used + need > totalT) break;
          used += need; n++;
        }
        return n;
      })(),
    };
  }

  /* ======================================================================
     4. 分摊课时（保留小数、总和必须等于总课时）
     ====================================================================== */

  /**
   * 按「建议课时」当权重分摊老师填的总课时。
   *
   * ⚠️ 这里最容易做错的一点（第一版连着做错两次，都记下来防止重踩）：
   *   ① **先按比例再逐行收上限** ⇒ 收完上限把总量削掉一大截：老师填 60 课时，
   *      只排进去 37.6，剩下 22.4 课时**没地方放**（上限只有在"比例给多了"时才该生效）。
   *   ② **把"建议课时"直接当初始分配、再拿预算补差** ⇒ **平均主义**：
   *      3 个模块（建议 9/6/3）配 30 课时，会变成 10.3/10/9.7，
   *      把"哪个模块更重"这件事彻底抹掉。
   *
   * ✅ 正确做法 = **先把权重整体缩放到预算上（定标），再收上下限，最后只补那点零头**：
   *      · 权重 = 建议课时（`hoursHint`；老师上一次手改过的额度优先）
   *      · 定标系数 k = max{ k : Σ clamp(round(k×权重), 下限, 上限) ≤ 总课时 }（逐 0.1 试）
   *      · 下限 = 1 课时；上限 = 建议课时 × 2（防止一个模块把预算吃光）
   *      · 剩下的零头按"离自己额度差得远"的顺序补 ⇒ **比例关系全程不被打乱**
   *      · 所有行都顶到上限还有余 ⇒ 如实报 `unallocated`（并给老师一条"加个专题模块"的提示）
   *      · 连"每行 1 课时"都给不起 ⇒ 按比例给并置 `shortfall:true`（明说，不静默）
   *      · **总和精确等于总课时**（差 0.1 都不行：附件3 的合计行照抄这个数）
   */
  function allocateHours(modules, totalHours, options) {
    const opt = options || {};
    const list = (modules || []).filter(Boolean);
    const totalT = Math.max(0, toTenths(totalHours));

    // 显式 0 课时的模块（科目包用 hoursHint:0 表达"本次不排"）单独摘出来，不参与分摊
    const active = [];
    const zeros = [];
    list.forEach((m) => {
      if (Number(m.hoursHint) === 0) zeros.push(m);
      else active.push(m);
    });
    if (!active.length) {
      const rows = zeros.map((m) => mkRow(m, 0));
      return { rows, allocated: 0, unallocated: fromTenths(totalT), overBy: 0, shortfall: false };
    }

    const minT = toTenths(MIN_ROW_HOURS);
    // 每行的上限 = 建议课时 × 2（防止一个模块把预算吃光）。
    // ⚠️ 这里踩过一个真 bug（记下来）：`hintTenths()` 返回的**已经是"分"**，
    //    第一版写成 `toTenths(hintTenths(m) * MAX_ROW_FACTOR)` ⇒ 又乘了 10，
    //    上限变成"建议课时的 20 倍"，等于没有上限（实测 47.3 课时配出 23.6/15.8/7.9）。
    //    凡是"分"参与的算术，**不要再套 toTenths**。
    // ⚠️ 刻意**不做** `lastPlanHours`（老师上一版手改过的课时）：老师手改是常事，
    //    把它当权重会让"改一行 → 重新生成"把别的行也跟着挪；宁可每次都从建议课时重算。
    const capT = active.map((m) => {
      const cap = Math.max(minT, hintTenths(m) * MAX_ROW_FACTOR);
      if (opt.maxHoursPerRow != null) return Math.min(cap, Math.max(minT, toTenths(opt.maxHoursPerRow)));
      return cap;
    });
    const wT = active.map((m) => hintTenths(m));

    // 能装下的最大量（每行都顶到上限）；以及"每行只给下限"的最低量
    let maxT = 0;
    for (let i = 0; i < active.length; i++) maxT += capT[i];
    const needMinT = active.length * minT;

    /* ---- 情形 A：总课时比"模块数 × 1 课时"还少 → 按权重比例给（可能低于 1 课时） ---- */
    if (totalT < needMinT) {
      const wsum = wT.reduce((a, b) => a + b, 0) || active.length;
      const tA = active.map((m, i) => Math.max(0, Math.round((totalT * wT[i]) / wsum)));
      const rowsA = active.map((m, i) => mkRow(m, fromTenths(tA[i])));
      const allA = zeros.map((m) => mkRow(m, 0)).concat(rowsA);
      const allocA = sumHours(rowsA.map((r) => r.hours));
      return {
        rows: allA,
        allocated: allocA,
        unallocated: fromTenths(Math.max(0, totalT - toTenths(allocA))),
        overBy: fromTenths(Math.max(0, toTenths(allocA) - totalT)),
        shortfall: true,
        lambda: 1,
      };
    }

    /* ---- 情形 B：定标 + 收上下限 + 补零头 ---- */

    /** 给定定标系数 k（0.1 一档），算出每行课时（分）与总和。
     *  ⚠️ 每行的上限**只有** `capT[i]`（= 建议课时 × 2），不要再夹一个 `totalT`：
     *     本轮真踩到 —— 那样会把"最小模块"的额度锁死在它自己的建议值上，
     *     总课时 240 时只能排进去 25（一列模块全被锁住，剩下的课时无处可放）。 */
    const scale = (k) => {
      const arr = active.map((m, i) => {
        const ideal = Math.round((wT[i] * k) / 10);
        return Math.min(capT[i], Math.max(minT, ideal));
      });
      return { arr, sum: arr.reduce((a, b) => a + b, 0) };
    };

    let lo = 0, hi = 1;
    let hiRes = scale(hi);
    // 找上界：一直翻倍到"总和已经超过预算"（最多翻 20 次，防呆）
    for (let i = 0; i < 20 && hiRes.sum < totalT; i++) {
      lo = hi;
      hi *= 2;
      hiRes = scale(hi);
    }
    // 二分：求最大的 k 使总和 ≤ 预算（逐 0.1 精度，300 次足够从 0 到 2^20）
    for (let i = 0; i < 300 && hi - lo > 1e-9; i++) {
      const mid = (lo + hi) / 2;
      if (scale(mid).sum <= totalT) lo = mid; else hi = mid;
    }

    const cur = scale(lo);
    const t = cur.arr;
    let sum = cur.sum;

    // 零头配平：按"离自己额度差得远"的顺序补（额度大的模块始终拿得多，比例不被打乱）
    let guard = 0;
    while (sum < totalT && guard++ < 200000) {
      let idx = -1, best = -Infinity;
      for (let i = 0; i < t.length; i++) {
        if (t[i] + 1 > capT[i]) continue;
        const gap = (wT[i] * lo) / 10 - t[i];
        if (gap > best) { best = gap; idx = i; }
      }
      if (idx < 0) {
        // 全都顶到上限了 ⇒ 还有余量放不下：改成"上限大的先给"，最后如实报 unallocated
        let idx2 = -1, capBest = -1;
        for (let i = 0; i < t.length; i++) {
          if (t[i] + 1 > capT[i]) continue;
          if (capT[i] > capBest) { capBest = capT[i]; idx2 = i; }
        }
        if (idx2 < 0) break;
        t[idx2] += 1; sum += 1;
        continue;
      }
      t[idx] += 1; sum += 1;
    }

    const rows = active.map((m, i) => mkRow(m, fromTenths(t[i])));
    const allRows = zeros.map((m) => mkRow(m, 0)).concat(rows);
    const allocated = sumHours(rows.map((r) => r.hours));
    const overByT = toTenths(allocated) > totalT ? toTenths(allocated) - totalT : 0;
    return {
      rows: allRows,
      allocated,
      unallocated: fromTenths(Math.max(0, totalT - toTenths(allocated))),
      overBy: fromTenths(overByT),
      shortfall: false,
      lambda: lo,
      capacity: fromTenths(maxT),
    };
  }

  /** 建一行（统一形状；模块包字段原样带出，方便界面显示章节/难度） */
  function mkRow(mod, hours) {
    return {
      id: mod.id,
      name: mod.name,
      stage: mod.stage || "",
      term: mod.term || "",
      lv: mod.lv,
      chapters: Array.isArray(mod.chapters) ? mod.chapters.slice() : [],
      content: mod.content || "",
      goal: mod.goal || "",
      tags: Array.isArray(mod.tags) ? mod.tags.slice() : [],
      hours: round1(hours),
    };
  }

  function hintTenths(mod) {
    const h = Number(mod && mod.hoursHint);
    if (!isFinite(h) || h <= 0) return toTenths(MIN_HINT);
    return toTenths(h);
  }

  /* ======================================================================
     5. 组装整份方案（界面/导出用的最终形状）
     ====================================================================== */

  /**
   * 输入：科目包 + 老师的参数
   * 输出：{ pack信息, rows（模块行）, groups（按复习阶段分组，供附件3 的"阶段"列分组显示）,
   *         totalHours, allocated, notes[]（给老师看的提示，不是报错） }
   */
  function buildPlan(pack, opts) {
    const o = opts || {};
    if (!pack) throw new Error("缺少科目包（subject pack）");
    const band = bandOf(pack, o.score);
    const picked = selectModules(pack, {
      grade: o.grade,
      score: o.score,
      band: band ? band.key : undefined,
      focus: o.focus,
      weakTopics: o.weakTopics,
      linked: o.linked,
      done: o.done,
      totalHours: o.totalHours,
    });

    const alloc = allocateHours(picked.modules, o.totalHours, {
      maxHoursPerRow: o.maxHoursPerRow,
    });

    const rows = alloc.rows.map((r) => Object.assign({}, r, {
      stageName: stageNameOf(pack, r.stage),
    }));

    const notes = [];
    if (picked.overBudget) {
      notes.push("总课时比「必开模块」的最低要求还少（" + picked.requiredCount + " 个必开模块 × 1 课时），已照排，请调大总课时。");
    }
    if (picked.dropped.length) {
      notes.push("课时只够排 " + picked.modules.length + " 个模块，另有 " + picked.dropped.length
        + " 个模块没排进来（" + picked.dropped.map((d) => d.name).slice(0, 4).join("、")
        + (picked.dropped.length > 4 ? " 等" : "") + "）；调大总课时或删模块即可排进。");
    }
    if (picked.removedDone.length) {
      notes.push("已跳过「学校已完成」的 " + picked.removedDone.length + " 个模块："
        + picked.removedDone.map((d) => d.name).join("、") + "。");
    }
    if (alloc.shortfall) {
      notes.push("总课时少于模块数（每模块至少要 1 课时），已按比例给到每个模块；建议调大总课时或减少模块。");
    }
    if (alloc.unallocated > 0) {
      notes.push("还有 " + alloc.unallocated + " 课时放不进这些模块（每个模块最多排建议课时的 2 倍），"
        + "建议加一个专题模块，或把总课时调小。");
    }
    if (alloc.overBy > 0) {
      notes.push("课时超出总预算 " + alloc.overBy + " 课时（模块太多），建议删模块或调大总课时。");
    }

    return {
      pack: { key: pack.key, name: pack.name, stage: pack.stage, stageName: pack.stageName || "", fullScore: pack.fullScore },
      band: band || null,
      grade: o.grade || "",
      rows,
      totalHours: round1(o.totalHours),
      allocated: alloc.allocated,
      unallocated: alloc.unallocated,
      shortfall: !!alloc.shortfall,
      notes,
      dropped: picked.dropped,
      removedDone: picked.removedDone,
    };
  }

  /** 阶段显示名（附件3 的"阶段"列；科目包用 stages 表给中文名） */
  function stageNameOf(pack, key) {
    if (!key) return "";
    const stages = (pack && pack.stages) || [];
    const hit = stages.filter((s) => s.key === key)[0];
    return hit ? hit.name : String(key);
  }

  /**
   * 按复习阶段分组（界面与附件3 都要：附件3 在阶段分组之间插一行合并的"阶段标题行"）。
   * 返回 [{stage, name, rows:[...]}]，顺序 = stages 表里声明的顺序，没声明的阶段排在最后。
   */
  function groupByStage(pack, rows) {
    const stages = (pack && pack.stages) || [];
    const rank = {};
    stages.forEach((s, i) => { rank[s.key] = i; });
    const buckets = [];
    const index = {};
    (rows || []).forEach((r) => {
      const k = r.stage || "";
      if (index[k] == null) {
        index[k] = buckets.length;
        buckets.push({ stage: k, name: stageNameOf(pack, k), rows: [] });
      }
      buckets[index[k]].rows.push(r);
    });
    buckets.sort((a, b) => {
      const ra = rank[a.stage] == null ? 900 : rank[a.stage];
      const rb = rank[b.stage] == null ? 900 : rank[b.stage];
      return ra - rb || a.name.localeCompare(b.name, "zh");
    });
    return buckets;
  }

  /* ======================================================================
     6. 自检（生成完给老师看的"核账"，与 math-plan 的 selfCheck 同一思路）
     ====================================================================== */

  /** 附件3 的合计行 = 各行之和；这里顺手把"对不上"变成一条可显示的检查项 */
  function selfCheck(plan) {
    const rows = (plan && plan.rows) || [];
    const sum = sumHours(rows.map((r) => r.hours));
    const total = round1(plan && plan.totalHours);
    const bad = [];
    rows.forEach((r, i) => {
      if (r.hours > 0 && toTenths(r.hours) % 1 !== 0) {
        // 只可能是 0.1 的整数倍（整数分），否则就是有人手改坏了
        bad.push("第 " + (i + 1) + " 行课时不是一位小数：" + r.hours);
      }
      if (!r.name) bad.push("第 " + (i + 1) + " 行没有模块名");
    });
    // 同名模块不该出现两次（附件3 会按模块名合并相邻行，重名会被合并掉 ⇒ 少一行）
    const seen = {};
    rows.forEach((r, i) => {
      if (seen[r.name]) bad.push("第 " + (i + 1) + " 行与第 " + seen[r.name] + " 行同名（" + r.name + "），导出时会被合并成一行");
      else seen[r.name] = i + 1;
    });
    return {
      rows: rows.length,
      sum,
      total,
      sumMatches: toTenths(sum) === toTenths(total),
      problems: bad,
      ok: bad.length === 0 && toTenths(sum) === toTenths(total),
    };
  }

  /* ======================================================================
     导出（Node 单测与浏览器都要用）
     ====================================================================== */
  return {
    // 小数工具
    toTenths, fromTenths, round1, sumHours,
    // 年级 / 顺序
    GRADE_RANK, gradeRank, termRank, seqOf, indexedModules, sortBySyllabus, modulesForGrade,
    // 评分 / 取舍
    bandOf, bandKeyOf, scoreModule, selectModules,
    // 课时
    allocateHours, mkRow, hintTenths,
    // 组装
    buildPlan, stageNameOf, groupByStage, selfCheck,
    // 常量（测试要断言口径时用）
    CONST: { MIN_HINT, MIN_ROW_HOURS, MAX_ROW_FACTOR },
  };
}));
