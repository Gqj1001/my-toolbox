/**
 * 科目包清单（加一个学科 = 在这里加一行）
 * ==========================================================================
 * ⚠️ 这个文件必须在科目包**之前**加载（`index.html` 里的顺序：manifest → subjects/*.js → subjects.js）。
 *    它只描述"有哪些科目包"，不含任何模块数据（那些在 `subjects/*.js` 里）。
 *
 * 字段：
 *   key      学科 code（**用工具现有那套**：chinese/math/english/physics/chemistry/
 *            biology/politics/history/geography/general —— 与 feedback.html 的 SUBJECTS 一致）
 *   name     学科名（物理）
 *   stage    学段 code：senior（高中）/ junior（初中）
 *   stageName 学段中文名
 *   file     科目包文件名（相对 `subjects/`）
 *   global   该文件挂在 window 上的全局变量名（浏览器的加载契约）
 *   grades   这个学段里可选的年级（界面下拉项），**顺序就是显示顺序**
 *   note     给老师看的一句话说明（可空）
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlanGenManifest = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SUBJECTS = [
    {
      key: "physics",
      name: "物理",
      stage: "senior",
      stageName: "高中",
      file: "physics-senior.js",
      global: "PlanGenSubjectPhysicsSenior",
      grades: ["高一", "高二", "高三", "新高二"],
      note: "人教版 2019 课标版；一轮 22 个模块 + 二轮力学大专题 + 收口 3 个"
    },
    {
      key: "physics",
      name: "物理",
      stage: "junior",
      stageName: "初中",
      file: "physics-junior.js",
      global: "PlanGenSubjectPhysicsJunior",
      grades: ["八年级", "八年级上", "八年级下", "九年级", "九年级上", "中考冲刺"],
      note: "人教版 2024；八上/八下/九全 + 中考一轮专题 + 冲刺（按年级筛）"
    },

    /* ---------- 初中数学（2026-10 新增）----------
       ⚠️ 只做**初中**：高中数学老师每天在用的是 math-plan（那个是"一行一次课"，
          与本工具"一行一模块"口径不同），所以这里刻意不碰高中数学。 */
    {
      key: "math",
      name: "数学",
      stage: "junior",
      stageName: "初中",
      file: "math-junior.js",
      global: "PlanGenSubjectMathJunior",
      grades: ["七年级", "七年级上", "七年级下", "八年级", "八年级上", "八年级下",
        "九年级", "九年级上", "九年级下", "中考冲刺"],
      note: "人教版 2024；七/八/九年级六个学期 + 中考一轮 12 个专题 + 冲刺 4 个（按年级筛）"
    },

    /* ---------- 英语（2026-10 新增，初高中两套）---------- */
    {
      key: "english",
      name: "英语",
      stage: "senior",
      stageName: "高中",
      file: "english-senior.js",
      global: "PlanGenSubjectEnglishSenior",
      grades: ["高一", "高一上", "高一下", "高二", "高二上", "高二下", "高三", "高考冲刺"],
      note: "人教版 2019；必修一~三 + 选择性必修一~四（单元轴）+ 一轮 9 个专题 + 二轮冲刺 4 个"
    },
    {
      key: "english",
      name: "英语",
      stage: "junior",
      stageName: "初中",
      file: "english-junior.js",
      global: "PlanGenSubjectEnglishJunior",
      grades: ["七年级", "七年级上", "七年级下", "八年级", "八年级上", "八年级下", "九年级", "中考冲刺"],
      note: "人教版 2024；七/八/九年级单元轴 + 中考一轮 9 个专题 + 冲刺 4 个（按年级筛）"
    },

    /* ---------- 语文（2026-10 新增，初高中两套；**一份文件导出两个包**）---------- */
    {
      key: "chinese",
      name: "语文",
      stage: "senior",
      stageName: "高中",
      file: "chinese.js",
      global: "PlanGenSubjectChineseSenior",
      grades: ["高一", "高一上", "高一下", "高二", "高三", "高考冲刺"],
      note: "人教版 2019；必修上/下 + 选必 + 一轮 7 大板块 + 二轮 3 个专项 + 三轮 2 个（按年级筛）"
    },
    {
      key: "chinese",
      name: "语文",
      stage: "junior",
      stageName: "初中",
      file: "chinese.js",
      global: "PlanGenSubjectChineseJunior",
      grades: ["七年级", "八年级", "九年级", "中考冲刺"],
      note: "人教版 2024；七/八/九年级 + 中考一轮专题 + 冲刺（按年级筛）"
    }
  ];

  /* 学科中文名（**唯一来源**：界面上的"学科"下拉、导出文件里的学科名都读这里） */
  var SUBJECT_NAMES = {
    chinese: "语文", math: "数学", english: "英语", physics: "物理",
    chemistry: "化学", biology: "生物", politics: "政治", history: "历史",
    geography: "地理", general: "通用"
  };

  /* 学段中文名与顺序 */
  var STAGES = [
    { key: "junior", name: "初中" },
    { key: "senior", name: "高中" }
  ];

  return {
    SUBJECTS: SUBJECTS,
    SUBJECT_NAMES: SUBJECT_NAMES,
    STAGES: STAGES
  };
}));
