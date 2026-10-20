/**
 * 辅导方案生成器 · 公司模板导出（附件3）
 * ==========================================================================
 * 干的事**只有三件**：
 *   ① **算日期**：由「总课时 ÷ 周课时」推"辅导时间"的起止（纯函数，可单测）
 *   ② **取数**：把当前方案（抬头 + 模块表）整理成公司引擎要的形状（纯函数，可单测）
 *   ③ **导出**：调 `CompanyDocx.build('附件3', data)` 并触发下载（**唯一碰 DOM/网络之外的东西**）
 *
 * ⚠️ 三条口径（照 `docs/company-attachment3-plan.md` + 数学版第十八批）：
 *   1. **不动公司引擎** `company-docx.js`（实测已直接吃下物理内容：23 模块 / 147 课时全对）。
 *      它内部会"按模块合并相邻同名行" —— 本工具**一行就是一个模块、模块名天然唯一**，
 *      所以合并逻辑对我们是恒等的（不会把两行并成一行）。
 *   2. **凡是工具里没有数据来源的格，一律留空给老师写**：效果评估、学情分析、措施、
 *      预期效果、成绩结果统计的"补习后"、签字栏 —— 一概不填，绝不用 AI 编。
 *   3. 一键开关沿用 `company_export`（与数学版**共用**后台那一行，无需新迁移），
 *      三种关法：常量 / `?nocompanyexport=1`（工具页直链或父页都认）/ localStorage。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlanGenCompany = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** 一键开关的 localStorage 键（**本工具专属**，别和数学版的 mp_ 混） */
  var LS_KEY = "pg_nocompanyexport";

  /* ======================================================================
     ① 日期推算（纯函数）
     ====================================================================== */

  /** 「YYYY年M月」 */
  function cnMonth(d) {
    return d.getFullYear() + "年" + (d.getMonth() + 1) + "月";
  }

  /**
   * 由「总课时 ÷ 周课时」推辅导时间的止月。
   *
   * ⚠️ 这里与数学版的算法**故意不同**（数学版是"今天 + 在校周数 + 假期周数"，那是按"排课周数"算的；
   *    本工具的输入只有"总课时"和"周课时"，按课时折算是唯一说得通的算法）：
   *      周数 = ceil(总课时 ÷ 周课时)，止月 = 今天 + 周数 × 7 天
   *    例：100 课时 ÷ 4 课时/周 = 25 周 ≈ 6 个月。
   *
   * @param totalHours     总课时（数字或字符串）
   * @param hoursPerWeek   周课时（数字或字符串；给 0 或空则退回 1，避免除以 0）
   * @param from           起点（默认今天；测试可传入固定日期）
   */
  function durationText(totalHours, hoursPerWeek, from) {
    var h = Number(totalHours);
    var w = Number(hoursPerWeek);
    if (!isFinite(h) || h <= 0) h = 1;
    if (!isFinite(w) || w <= 0) w = 1;
    var weeks = Math.max(1, Math.ceil(h / w));
    var start = from instanceof Date ? from : new Date();
    var end = new Date(start.getTime() + weeks * 7 * 24 * 3600 * 1000);
    return cnMonth(start) + "--" + cnMonth(end);
  }

  /** 周课时默认值：由"总课时 ÷ 周数"反推不现实，就按老师填的频次（次/周）当默认 */
  function defaultHoursPerWeek(freq) {
    var f = Number(freq);
    if (!isFinite(f) || f <= 0) return "2";
    return String(f);
  }

  /* ======================================================================
     ② 取数（纯函数）
     ====================================================================== */

  /** 一行 → 公司引擎要的 {module, content, goal, hours} */
  function rowPayload(row) {
    var r = row || {};
    return {
      module: String(r.name == null ? "" : r.name),
      content: String(r.content == null ? "" : r.content),
      goal: String(r.goal == null ? "" : r.goal),
      hours: Number(r.hours) || 0
    };
  }

  /**
   * 组装 company-docx 的附件3 入参。
   * @param opts {
   *   student, school, grade, teacher,          // 抬头（学校年级那一格用"学校+年级"）
   *   totalHours, hoursPerWeek, durationText,   // 辅导课时 / 周课时 / 辅导时间
   *   entryScore,                               // 入学成绩（可留空）
   *   rows,                                     // 模块行（引擎的输出）
   *   now                                       // 可选：固定"今天"（测试用）
   * }
   */
  function buildCompany3Data(opts) {
    var o = opts || {};
    var rows = (o.rows || []).map(rowPayload);
    var total = Number(o.totalHours);
    if (!isFinite(total) || total < 0) total = 0;
    var hpw = o.hoursPerWeek == null || o.hoursPerWeek === "" ? "2" : String(o.hoursPerWeek);
    return {
      student: String(o.student == null ? "" : o.student),
      // 附件3 的抬头格是「学校年级」：模板样例写的是「天津高三」
      school: String(o.school == null ? "" : o.school),
      grade: String(o.grade == null ? "" : o.grade),
      teacher: String(o.teacher == null ? "" : o.teacher),
      totalHours: total,
      durationText: o.durationText ? String(o.durationText) : durationText(total, hpw, o.now),
      hoursPerWeekText: hpw,
      entryScore: String(o.entryScore == null ? "" : o.entryScore),
      rows: rows,
      // ★ 2026-10 用户线上验收：「导出的 Word 里显示 1.1小时」⇒ 单位要用「课时」。
      //   公司引擎 `company-docx.js` 原本把单位写死成「小时」；为了**不改数学版的输出**
      //   （数学版一直在用、验收过），给它加了一个可选项 `hoursUnit`（默认仍是「小时」），
      //   本工具显式传「课时」。
      hoursUnit: "课时",
      // ⚠️ 一期留空（工具没有"过程数据"）：效果评估列由老师在 Word 里写
      lessonEval: {}
    };
  }

  /* ======================================================================
     ③ 一键开关（三种关法）
     ====================================================================== */

  /**
   * @param opt {
   *   enabled:  代码常量（false = 关）
   *   search:   本页的 query string（默认 location.search）
   *   parentSearch: 父页的 query string（拿不到就传 null）
   *   storage:  取 localStorage 的函数（默认读 LS_KEY）
   * }
   * @returns true = 已关闭
   */
  function isDisabled(opt) {
    var o = opt || {};
    try {
      if (o.enabled === false) return true;
      var q = o.search != null ? o.search : "";
      if (new RegExp("[?&]nocompanyexport=1(&|$)").test(String(q))) return true;
      if (o.parentSearch && new RegExp("[?&]nocompanyexport=1(&|$)").test(String(o.parentSearch))) return true;
      if (o.storage && o.storage() === "1") return true;
      return false;
    } catch (e) {
      return false;   // 读不到就当我开着（宁可用不了也别静默消失）
    }
  }

  /** 浏览器里的取关法（把环境读一遍再交给纯函数判断） */
  function browserDisabled() {
    var parentSearch = null;
    try {
      if (typeof window !== "undefined" && window.parent && window.parent !== window) {
        parentSearch = window.parent.location.search;
      }
    } catch (e) { parentSearch = null; }
    var ls = null;
    try { ls = window.localStorage.getItem(LS_KEY); } catch (e) { ls = null; }
    return isDisabled({
      enabled: typeof COMPANY3_ENABLED === "undefined" ? true : COMPANY3_ENABLED,
      search: (typeof location !== "undefined" ? location.search : ""),
      parentSearch: parentSearch,
      storage: function () { return ls; }
    });
  }

  /** 代码常量（紧急关闭用；与数学版的 COMPANY3_ENABLED 同名，各自文件里独立） */
  var COMPANY3_ENABLED = true;

  /** 导出的文件名：`张三-附件3-辅导计划.docx` */
  function fileNameOf(student) {
    var s = String(student == null ? "" : student).trim();
    return (s || "学生") + "-附件3-辅导计划.docx";
  }

  /* ======================================================================
     导出（真正碰 DOM：造 Blob + 触发下载）
     ====================================================================== */
  /**
   * @param engine   全局 `CompanyDocx`（没加载就抛一句人话）
   * @param data     buildCompany3Data() 的结果
   * @returns {{bytes: number, name: string}}
   */
  function download(engine, data, doc) {
    var d = doc || (typeof document !== "undefined" ? document : null);
    if (!d) throw new Error("没有可用的 document（这段只能在浏览器里跑）");
    if (!engine || typeof engine.build !== "function") {
      throw new Error("公司模板导出模块没加载，请刷新页面");
    }
    var bin = engine.build("附件3", data);
    var blob = new Blob([bin], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    var name = fileNameOf(data && data.student);
    var a = d.createElement("a");
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    d.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    return { bytes: bin.length, name: name };
  }

  return {
    LS_KEY: LS_KEY,
    // ① 日期
    cnMonth: cnMonth,
    durationText: durationText,
    defaultHoursPerWeek: defaultHoursPerWeek,
    // ② 取数
    rowPayload: rowPayload,
    buildCompany3Data: buildCompany3Data,
    // ③ 开关
    isDisabled: isDisabled,
    browserDisabled: browserDisabled,
    COMPANY3_ENABLED: COMPANY3_ENABLED,
    // 导出
    fileNameOf: fileNameOf,
    download: download
  };
}));
