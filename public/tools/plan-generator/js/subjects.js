/**
 * 科目包加载与装配（学科无关的公共入口）
 * ==========================================================================
 * 这个文件是"学科配置"与"程序"之间的**唯一接口**。它自己不含任何学科内容。
 *
 * 加载契约（**两种环境同一套数据，不需要异步注入**）：
 *   · 浏览器：`index.html` 按顺序引入
 *       subjects/manifest.js → subjects/physics-senior.js → subjects/physics-junior.js → js/subjects.js
 *     每个科目包把数据挂在 window 上（`PlanGenSubjectPhysicsSenior` …），
 *     `subjects.js` 直接读这些全局变量 ⇒ **同步可用**，没有"等脚本加载完"的时序问题。
 *   · Node（单测）：`require('./subjects/physics-senior.js')` 一样能用（UMD）。
 *     ⚠️ 但**浏览器不能 require**，所以 `loadPack()` 两个分支都要留着。
 *
 * ⚠️ 为什么不动态插 `<script>` 标签：那会让"读科目包"变成异步，
 *    而工具页在启动时就要用它能排的年级去填下拉框（同步）。这个坑不值得踩。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    // ⚠️ 必须**在这一层**用 __dirname 拼路径：写 `require("./subjects/manifest.js")` 会相对
    //    **调用方**解析（单测从仓库根 require 时会变成 <仓库根>/subjects/... ⇒ MODULE_NOT_FOUND）。
    //    本轮真踩到，记下来。
    var path = require("path");
    // ⚠️ 本文件在 `js/` 下，科目包在**上一级**的 `subjects/` 下（同一个名字、不同层，容易搞混）。
    var SUB_DIR = path.join(__dirname, "..", "subjects");
    module.exports = factory(root,
      require(path.join(SUB_DIR, "manifest.js")),
      function (rel) { return require(path.join(SUB_DIR, rel)); }
    );
  } else {
    // ⚠️ `root` 必须**显式传给工厂**：第一版在工厂里直接用外层包装函数的形参 `root`，
    //    Node 侧走的是另一条分支所以单测全绿，浏览器里却 `ReferenceError: root is not defined`
    //    ⇒ 整页打不开。JS 的作用域规则而已，但只有真浏览器才暴露（所以界面测试不能省）。
    root.PlanGenSubjects = factory(root, root.PlanGenManifest, null);
  }
}(typeof self !== "undefined" ? self : this, function (root, MANIFEST, nodeRequirePack) {
  "use strict";

  if (!MANIFEST) throw new Error("subjects.js 需要先加载 subjects/manifest.js");

  var IS_NODE = !!nodeRequirePack;

  /** 已加载的科目包缓存：`key|stage` → pack */
  var CACHE = {};

  var cacheKeyOf = function (key, stage) { return String(key) + "|" + String(stage); };

  /** 清单里的一条（找不到返回 null） */
  function entryOf(key, stage) {
    var hit = MANIFEST.SUBJECTS.filter(function (s) {
      return s.key === key && s.stage === stage;
    });
    return hit.length ? hit[0] : null;
  }

  /**
   * 取一个科目包。
   * @param key   学科 code（physics）
   * @param stage 学段 code（senior / junior）
   * @returns 科目包对象；**没有这个组合就返回 null**（调用方负责给老师一句人话）
   *
   * ⚠️ **一份文件可以导出两个包**（语文就是：初高中共用一份 `chinese.js`）。
   *    判据：拿到的对象若带 `senior` / `junior` 两个键，就按 stage 取其中一个；
   *    否则它就是包本身（`key` / `stage` / `modules` 这些字段直接挂在上面）。
   *    这样"每个学科一个文件"与"一份文件出两个学段"两种写法都能用。
   */
  function loadPack(key, stage) {
    var ck = cacheKeyOf(key, stage);
    if (CACHE[ck]) return CACHE[ck];

    var entry = entryOf(key, stage);
    if (!entry) return null;

    var raw = null;
    if (IS_NODE) {
      // Node：按文件名 require（单测用）
      try {
        raw = nodeRequirePack(entry.file);
      } catch (e) {
        raw = null;
      }
    } else {
      // 浏览器：读 window 上的全局变量（由 <script> 按顺序加载，同步可用）
      raw = root[entry.global] || null;
    }

    var pack = raw;
    if (raw && typeof raw === "object" && raw.modules === undefined
        && (raw.senior || raw.junior)) {
      pack = raw[stage] || null;
    }
    if (pack) CACHE[ck] = pack;
    return pack;
  }

  /** 清单里全部科目包（只加载得出来的那些） */
  function allPacks() {
    return MANIFEST.SUBJECTS.map(function (s) { return loadPack(s.key, s.stage); })
      .filter(Boolean);
  }

  /** 有哪些学科（去重，按清单顺序） */
  function subjectList() {
    var seen = {}, out = [];
    MANIFEST.SUBJECTS.forEach(function (s) {
      if (seen[s.key]) return;
      seen[s.key] = true;
      out.push({ key: s.key, name: s.name });
    });
    return out;
  }

  /**
   * 某个学科有哪些学段（去重，按清单顺序）。
   * ⚠️ 只有物理时返回 [senior, junior]；将来加化学就自动多一组 —— **界面不用改**。
   */
  function stageListOf(key) {
    var seen = {}, out = [];
    MANIFEST.SUBJECTS.filter(function (s) { return s.key === key; }).forEach(function (s) {
      if (seen[s.stage]) return;
      seen[s.stage] = true;
      out.push({ key: s.stage, name: s.stageName });
    });
    return out;
  }

  /** 某个"学科 + 学段"可选的年级（界面下拉项） */
  function gradesOf(key, stage) {
    var e = entryOf(key, stage);
    return e && e.grades ? e.grades.slice() : [];
  }

  /** 学科中文名（唯一来源） */
  function subjectNameOf(key) {
    return MANIFEST.SUBJECT_NAMES[key] || String(key || "");
  }

  /** 学段中文名 */
  function stageNameOf(key) {
    var hit = MANIFEST.STAGES.filter(function (s) { return s.key === key; });
    return hit.length ? hit[0].name : String(key || "");
  }

  /**
   * 自检：科目包与清单必须对得上。
   * 返回 `{ok, problems:[]}`（**不抛异常** —— 由调用方决定是提示还是拦下）。
   * 这些检查同时也是测试要断言的内容（清单里有的，必须真能加载出来）。
   */
  function validate() {
    var problems = [];
    MANIFEST.SUBJECTS.forEach(function (s) {
      var pack = loadPack(s.key, s.stage);
      var tag = s.key + "/" + s.stage;
      if (!pack) { problems.push(tag + "：科目包加载不出来（文件 " + s.file + " 或全局变量 " + s.global + " 不对）"); return; }
      if (pack.key !== s.key) problems.push(tag + "：pack.key=" + pack.key + " 与清单不一致");
      if (pack.stage !== s.stage) problems.push(tag + "：pack.stage=" + pack.stage + " 与清单不一致");
      if (!Array.isArray(pack.modules) || !pack.modules.length) problems.push(tag + "：没有 modules");
      if (!Array.isArray(pack.bands) || !pack.bands.length) problems.push(tag + "：没有 bands（档位线）");
      if (!Array.isArray(pack.stages) || !pack.stages.length) problems.push(tag + "：没有 stages（复习阶段）");
      if (!pack.grades || !Object.keys(pack.grades).length) problems.push(tag + "：没有 grades（年级表）");

      var ids = {}, names = {};
      (pack.modules || []).forEach(function (m) {
        if (!m.id) problems.push(tag + "：有模块没有 id");
        else if (ids[m.id]) problems.push(tag + "：模块 id 重复 " + m.id);
        else ids[m.id] = true;
        if (!m.name) problems.push(tag + "：" + m.id + " 没有 name");
        else if (names[m.name]) problems.push(tag + "：模块名重复（附件3 会按名字合并行）" + m.name);
        else names[m.name] = true;
        if (!m.stage) problems.push(tag + "：" + m.id + " 没有 stage（附件3 的「阶段」列要用）");
        if (m.hoursHint == null || isNaN(Number(m.hoursHint))) problems.push(tag + "：" + m.id + " 的 hoursHint 不是数字");
        if (!Array.isArray(m.chapters) || !m.chapters.length) problems.push(tag + "：" + m.id + " 没有 chapters（教材小节）");
        if (m.content == null) problems.push(tag + "：" + m.id + " 没有 content 字段（可为空串）");
        if (m.goal == null) problems.push(tag + "：" + m.id + " 没有 goal 字段（刻意留空也要有）");
      });

      // 年级表里点名的 id 必须真实存在（写错一个字母，那个年级就少一个模块 —— 极难发现）
      var gradeKeys = Object.keys(pack.grades || {});
      gradeKeys.forEach(function (g) {
        (pack.grades[g] || []).forEach(function (id) {
          if (!ids[id]) problems.push(tag + "：年级「" + g + "」里点名了不存在的模块 " + id);
        });
      });
      // 清单里声明的年级，pack 里必须都有
      (s.grades || []).forEach(function (g) {
        if (gradeKeys.indexOf(g) < 0) problems.push(tag + "：清单声明了年级「" + g + "」，但 pack.grades 里没有");
      });
      // stage 键必须都在 stages 表里
      var stageKeys = (pack.stages || []).map(function (x) { return x.key; });
      (pack.modules || []).forEach(function (m) {
        if (m.stage && stageKeys.indexOf(m.stage) < 0) {
          problems.push(tag + "：" + m.id + " 的 stage「" + m.stage + "」没有在 stages 表里声明");
        }
      });
    });
    return { ok: problems.length === 0, problems: problems };
  }

  return {
    // 加载
    loadPack: loadPack,
    allPacks: allPacks,
    // 清单派生（界面下拉用）
    subjectList: subjectList,
    stageListOf: stageListOf,
    gradesOf: gradesOf,
    subjectNameOf: subjectNameOf,
    stageNameOf: stageNameOf,
    // 自检
    validate: validate,
    MANIFEST: MANIFEST
  };
}));
