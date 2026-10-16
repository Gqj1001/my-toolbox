/**
 * 科目包：初中物理（人教版 2024）· 按年级分册 · 37 个模块
 * ==========================================================================
 * ⚠️ 这是**配置**，不是程序。改模块/改课时只动这一个文件，程序代码一行不用改。
 *
 * 数据来源（老师给的 2 份真实辅导计划 + 人教社目录）：
 *   · other-subjects/junior/physics/辅导计划/初三全托班组物理辅导计划.doc  ← 同步 8 + 一轮 13 + 冲刺
 *   · other-subjects/junior/physics/辅导计划/张雨宸初三辅导计划.docx       ← 一对一短周期（**含 0 课时**的章）
 *   · 章节号：人教社八上 / 八下 / 九年级全一册目录（2024 版，第二十一、二十二章仍保留）
 *
 * 口径（与高中那份一致）：
 *   1. `content` 只放教材真实存在的小节（照人教社目录抄），**不许 AI 编**；
 *   2. `goal` 刻意留空，由 AI 生成初稿、老师就地改；
 *   3. `hoursHint` 是样例里的原始课时（含 1.5 / 4.5 / 7.5 / 10.5 小数），当权重用；
 *   4. **`hoursHint: 0` 是合法值** —— 语义是"已掌握、本次不排"（张雨宸那份样例里真有
 *      「第十三章内能 0」），引擎会照给 0 课时，界面上老师可以自己改。
 *
 * ⭐ "宁多勿少"的落地方式：**模块库装全（七/八/九年级 + 中考一轮专题），用年级表来筛**。
 *    选"八年级"就只看到八年级那 6 个，选"九年级"看到九年级 14 个 + 一轮专题 13 个。
 *    将来老师要加/删，改这个文件即可（`docs/physics-module-list-draft.md` 有 6 个待确认点）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PlanGenSubjectPhysicsJunior = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STAGES = [
    { key: "g8a", name: "八年级上册" },
    { key: "g8b", name: "八年级下册" },
    { key: "g9", name: "九年级全一册" },
    { key: "review", name: "中考一轮专题复习" },
    { key: "sprint", name: "中考冲刺" }
  ];

  var MODULES = [
    /* ---------------- 八年级上册 ---------------- */
    {
      id: "j01", name: "机械运动", stage: "g8a", term: "八年级上", lv: 1, hoursHint: 3,
      topic: "力学", tags: ["基础", "高频"], must: false,
      chapters: ["1.1长度和时间的测量", "1.2运动的描述", "1.3运动的快慢", "1.4测量平均速度"],
      content: "1.1长度和时间的测量 1.2运动的描述 1.3运动的快慢 1.4测量平均速度",
      goal: ""
    },
    {
      id: "j02", name: "声现象", stage: "g8a", term: "八年级上", lv: 1, hoursHint: 3,
      topic: "声学", tags: ["送分题"], must: false,
      chapters: ["2.1声音的产生与传播", "2.2声音的特性", "2.3声的利用", "2.4噪声的危害和控制"],
      content: "2.1声音的产生与传播 2.2声音的特性 2.3声的利用 2.4噪声的危害和控制",
      goal: ""
    },
    {
      id: "j03", name: "物态变化", stage: "g8a", term: "八年级上", lv: 1, hoursHint: 3,
      topic: "热学", tags: ["基础", "易错点"], must: false,
      chapters: ["3.1温度", "3.2熔化和凝固", "3.3汽化和液化", "3.4升华和凝华"],
      content: "3.1温度 3.2熔化和凝固 3.3汽化和液化 3.4升华和凝华",
      goal: ""
    },
    {
      id: "j04", name: "光现象", stage: "g8a", term: "八年级上", lv: 1, hoursHint: 3,
      topic: "光学", tags: ["基础", "高频"], must: false,
      chapters: ["4.1光的直线传播", "4.2光的反射", "4.3平面镜成像", "4.4光的折射", "4.5光的色散"],
      content: "4.1光的直线传播 4.2光的反射 4.3平面镜成像 4.4光的折射 4.5光的色散",
      goal: ""
    },
    {
      id: "j05", name: "透镜及其应用", stage: "g8a", term: "八年级上", lv: 2, hoursHint: 4.5,
      topic: "光学", tags: ["高频", "难点"], must: false,
      chapters: ["5.1透镜", "5.2生活中的透镜", "5.3凸透镜成像的规律", "5.4眼睛和眼镜", "5.5显微镜和望远镜"],
      content: "5.1透镜 5.2生活中的透镜 5.3凸透镜成像的规律 5.4眼睛和眼镜 5.5显微镜和望远镜",
      goal: ""
    },
    {
      id: "j06", name: "质量与密度", stage: "g8a", term: "八年级上", lv: 2, hoursHint: 3,
      topic: "力学", tags: ["高频", "实验"], must: false,
      chapters: ["6.1质量", "6.2密度", "6.3测量物质的密度", "6.4密度的应用"],
      content: "6.1质量 6.2密度 6.3测量物质的密度 6.4密度的应用",
      goal: ""
    },

    /* ---------------- 八年级下册 ---------------- */
    {
      id: "j07", name: "力与运动和力", stage: "g8b", term: "八年级下", lv: 2, hoursHint: 9,
      topic: "力学", tags: ["高频", "基础"], must: false,
      chapters: [
        "7.1力", "7.2弹力", "7.3重力",
        "8.1牛顿第一定律", "8.2二力平衡", "8.3摩擦力"
      ],
      content: "7.1力 7.2弹力 7.3重力 8.1牛顿第一定律 8.2二力平衡 8.3摩擦力",
      goal: ""
    },
    {
      id: "j08", name: "压强", stage: "g8b", term: "八年级下", lv: 2, hoursHint: 6,
      topic: "力学", tags: ["高频", "计算"], must: false,
      chapters: ["9.1压强", "9.2液体的压强", "9.3大气压强", "9.4流体压强与流速的关系"],
      content: "9.1压强 9.2液体的压强 9.3大气压强 9.4流体压强与流速的关系",
      goal: ""
    },
    {
      id: "j09", name: "浮力", stage: "g8b", term: "八年级下", lv: 3, hoursHint: 7.5,
      topic: "力学", tags: ["高频", "难点", "计算"], must: false,
      chapters: ["10.1浮力", "10.2阿基米德原理", "10.3物体的浮沉条件及应用"],
      content: "10.1浮力 10.2阿基米德原理 10.3物体的浮沉条件及应用",
      goal: ""
    },
    {
      id: "j10", name: "功和机械能", stage: "g8b", term: "八年级下", lv: 2, hoursHint: 6,
      topic: "力学", tags: ["高频", "计算"], must: false,
      chapters: ["11.1功", "11.2功率", "11.3动能和势能", "11.4机械能及其转化"],
      content: "11.1功 11.2功率 11.3动能和势能 11.4机械能及其转化",
      goal: ""
    },
    {
      id: "j11", name: "简单机械", stage: "g8b", term: "八年级下", lv: 3, hoursHint: 7.5,
      topic: "力学", tags: ["高频", "难点", "计算"], must: false,
      chapters: ["12.1杠杆", "12.2滑轮", "12.3机械效率"],
      content: "12.1杠杆 12.2滑轮 12.3机械效率",
      goal: ""
    },

    /* ---------------- 九年级全一册 ---------------- */
    {
      id: "j12", name: "内能", stage: "g9", term: "九年级", lv: 1, hoursHint: 4.5,
      topic: "热学", tags: ["基础", "高频"], must: false,
      chapters: ["13.1分子热运动", "13.2内能", "13.3比热容"],
      content: "13.1分子热运动 13.2内能 13.3比热容",
      goal: ""
    },
    {
      id: "j13", name: "内能的利用", stage: "g9", term: "九年级", lv: 1, hoursHint: 4.5,
      topic: "热学", tags: ["基础"], must: false,
      chapters: ["14.1热机", "14.2热机的效率", "14.3能量的转化和守恒"],
      content: "14.1热机 14.2热机的效率 14.3能量的转化和守恒",
      goal: ""
    },
    {
      id: "j14", name: "电流和电路", stage: "g9", term: "九年级", lv: 1, hoursHint: 7.5,
      topic: "电学", tags: ["基础", "高频"], must: false,
      chapters: ["15.1两种电荷", "15.2电流和电路", "15.3串联和并联", "15.4电流的测量", "15.5串、并联电路中电流的规律"],
      content: "15.1两种电荷 15.2电流和电路 15.3串联和并联 15.4电流的测量 15.5串、并联电路中电流的规律",
      goal: ""
    },
    {
      id: "j15", name: "电压 电阻", stage: "g9", term: "九年级", lv: 2, hoursHint: 7.5,
      topic: "电学", tags: ["基础", "高频"], must: false,
      chapters: ["16.1电压", "16.2串、并联电路中电压的规律", "16.3电阻", "16.4变阻器"],
      content: "16.1电压 16.2串、并联电路中电压的规律 16.3电阻 16.4变阻器",
      goal: ""
    },
    {
      id: "j16", name: "欧姆定律", stage: "g9", term: "九年级", lv: 3, hoursHint: 10.5,
      topic: "电学", tags: ["高频", "难点", "计算"], must: false,
      chapters: ["17.1电流与电压和电阻的关系", "17.2欧姆定律", "17.3电阻的测量", "17.4欧姆定律在串、并联电路中的应用"],
      content: "17.1电流与电压和电阻的关系 17.2欧姆定律 17.3电阻的测量 17.4欧姆定律在串、并联电路中的应用",
      goal: ""
    },
    {
      id: "j17", name: "电功率", stage: "g9", term: "九年级", lv: 3, hoursHint: 10.5,
      topic: "电学", tags: ["高频", "难点", "计算"], must: false,
      chapters: ["18.1电能 电功", "18.2电功率", "18.3测量小灯泡的电功率", "18.4焦耳定律"],
      content: "18.1电能 电功 18.2电功率 18.3测量小灯泡的电功率 18.4焦耳定律",
      goal: ""
    },
    {
      id: "j18", name: "生活用电", stage: "g9", term: "九年级", lv: 1, hoursHint: 3,
      topic: "电学", tags: ["送分题"], must: false,
      chapters: ["19.1家庭电路", "19.2家庭电路中电流过大的原因", "19.3安全用电"],
      content: "19.1家庭电路 19.2家庭电路中电流过大的原因 19.3安全用电",
      goal: ""
    },
    {
      id: "j19", name: "电与磁", stage: "g9", term: "九年级", lv: 1, hoursHint: 6,
      topic: "电磁", tags: ["送分题"], must: false,
      chapters: ["20.1磁现象 磁场", "20.2电生磁", "20.3电磁铁 电磁继电器", "20.4电动机", "20.5磁生电"],
      content: "20.1磁现象 磁场 20.2电生磁 20.3电磁铁 电磁继电器 20.4电动机 20.5磁生电",
      goal: ""
    },
    {
      id: "j20", name: "信息的传递", stage: "g9", term: "九年级", lv: 1, hoursHint: 1.5,
      topic: "电磁", tags: ["送分题"], must: false,
      chapters: ["21.1现代顺风耳——电话", "21.2电磁波的海洋", "21.3广播、电视和移动通信", "21.4越来越宽的信息之路"],
      content: "21.1现代顺风耳——电话 21.2电磁波的海洋 21.3广播、电视和移动通信 21.4越来越宽的信息之路",
      goal: ""
    },
    {
      id: "j21", name: "能源与可持续发展", stage: "g9", term: "九年级", lv: 1, hoursHint: 1.5,
      topic: "能源", tags: ["送分题"], must: false,
      chapters: ["22.1能源", "22.2核能", "22.3太阳能", "22.4能源与可持续发展"],
      content: "22.1能源 22.2核能 22.3太阳能 22.4能源与可持续发展",
      goal: ""
    },

    /* ---------------- 中考一轮专题复习（初三全托样例的"一轮复习 54h"那一段） ---------------- */
    {
      id: "j22", name: "声现象专题", stage: "review", term: "九年级", lv: 1, hoursHint: 1.5,
      topic: "声学", tags: ["一轮", "送分题"], must: false,
      chapters: ["声音的产生与传播", "声音的特性", "声的利用", "噪声的危害和控制"],
      content: "声音的产生与传播 声音的特性 声的利用 噪声的危害和控制",
      goal: ""
    },
    {
      id: "j23", name: "光现象专题", stage: "review", term: "九年级", lv: 1, hoursHint: 3,
      topic: "光学", tags: ["一轮", "高频"], must: false,
      chapters: ["光的直线传播", "光的反射", "平面镜成像", "光的折射", "光的色散"],
      content: "光的直线传播 光的反射 平面镜成像 光的折射 光的色散",
      goal: ""
    },
    {
      id: "j24", name: "透镜及其应用专题", stage: "review", term: "九年级", lv: 2, hoursHint: 4.5,
      topic: "光学", tags: ["一轮", "难点"], must: false,
      chapters: ["透镜", "生活中的透镜", "凸透镜成像规律", "近视镜和远视镜的应用"],
      content: "透镜 生活中的透镜 凸透镜成像规律 近视镜和远视镜的应用",
      goal: ""
    },
    {
      id: "j25", name: "物态变化专题", stage: "review", term: "九年级", lv: 1, hoursHint: 3,
      topic: "热学", tags: ["一轮"], must: false,
      chapters: ["温度", "熔化和凝固", "汽化和液化", "升华和凝华"],
      content: "温度 熔化和凝固 汽化和液化 升华和凝华",
      goal: ""
    },
    {
      id: "j26", name: "内能专题", stage: "review", term: "九年级", lv: 1, hoursHint: 3,
      topic: "热学", tags: ["一轮", "高频"], must: false,
      chapters: ["分子热运动", "内能", "比热容"],
      content: "分子热运动 内能 比热容",
      goal: ""
    },
    {
      id: "j27", name: "内能的利用专题", stage: "review", term: "九年级", lv: 1, hoursHint: 3,
      topic: "热学", tags: ["一轮"], must: false,
      chapters: ["热机", "热机的效率", "能量的转化与守恒"],
      content: "热机 热机的效率 能量的转化与守恒",
      goal: ""
    },
    {
      id: "j28", name: "力学基础专题", stage: "review", term: "九年级", lv: 2, hoursHint: 9,
      topic: "力学", tags: ["一轮", "基础"], must: false,
      chapters: ["力", "重力 弹力", "牛顿第一定律", "摩擦力", "力的合成", "二力平衡"],
      content: "力 重力 弹力 牛顿第一定律 摩擦力 力的合成 二力平衡",
      goal: ""
    },
    {
      id: "j29", name: "压强专题", stage: "review", term: "九年级", lv: 2, hoursHint: 6,
      topic: "力学", tags: ["一轮", "计算"], must: false,
      chapters: ["压强", "液体压强", "大气压强", "流体压强与流速的关系"],
      content: "压强 液体压强 大气压强 流体压强与流速的关系",
      goal: ""
    },
    {
      id: "j30", name: "浮力专题", stage: "review", term: "九年级", lv: 3, hoursHint: 7.5,
      topic: "力学", tags: ["一轮", "难点", "计算"], must: false,
      chapters: ["浮力的产生", "阿基米德原理", "沉浮条件及其应用", "质量密度与浮力实验"],
      content: "浮力的产生 阿基米德原理 沉浮条件及其应用 质量密度与浮力实验",
      goal: ""
    },
    {
      id: "j31", name: "功和机械能专题", stage: "review", term: "九年级", lv: 2, hoursHint: 6,
      topic: "力学", tags: ["一轮", "计算"], must: false,
      chapters: ["功", "功率", "动能和势能", "机械能及其转化"],
      content: "功 功率 动能和势能 机械能及其转化",
      goal: ""
    },
    {
      id: "j32", name: "简单机械专题", stage: "review", term: "九年级", lv: 3, hoursHint: 7.5,
      topic: "力学", tags: ["一轮", "难点", "计算"], must: false,
      chapters: ["杠杆", "滑轮", "机械效率"],
      content: "杠杆 滑轮 机械效率",
      goal: ""
    },
    {
      id: "j33", name: "电学综合专题", stage: "review", term: "九年级", lv: 3, hoursHint: 10.5,
      topic: "电学", tags: ["一轮", "难点", "计算"], must: false,
      chapters: ["电路分析", "欧姆定律综合计算", "电功率综合计算", "电学实验"],
      content: "电路分析 欧姆定律综合计算 电功率综合计算 电学实验",
      goal: ""
    },

    /* ---------------- 中考冲刺（收口，必开） ---------------- */
    {
      id: "j34", name: "中考实验·讲解与实操", stage: "sprint", term: "收口", lv: 2, hoursHint: 9,
      topic: "实验", tags: ["必开", "实验"], must: true,
      chapters: ["中考必考实验知识讲解", "中考实验操作与练习"],
      content: "中考必考实验知识讲解、实验步骤与结论的记忆与理解；中考实验操作与练习",
      goal: ""
    },
    {
      id: "j35", name: "力学综合计算", stage: "sprint", term: "收口", lv: 3, hoursHint: 7.5,
      topic: "力学", tags: ["必开", "计算"], must: true,
      chapters: ["压强、浮力、简单机械的综合计算", "相关力学实验"],
      content: "压强、浮力、简单机械的综合计算及相关力学实验",
      goal: ""
    },
    {
      id: "j36", name: "电学综合计算", stage: "sprint", term: "收口", lv: 3, hoursHint: 7.5,
      topic: "电学", tags: ["必开", "计算"], must: true,
      chapters: ["电学计算", "电路分析", "电学实验"],
      content: "电学计算、电路分析及电学实验",
      goal: ""
    },
    {
      id: "j37", name: "中考模拟", stage: "sprint", term: "收口", lv: 2, hoursHint: 21,
      topic: "模拟", tags: ["必开", "限时"], must: true,
      chapters: ["中考真题与模拟卷限时训练", "按中考卷面结构分配时间"],
      content: "中考真题与模拟卷限时训练、按中考卷面结构分配时间、错题滚动重做",
      goal: ""
    }
  ];

  var G8A = ["j01", "j02", "j03", "j04", "j05", "j06"];
  var G8B = ["j07", "j08", "j09", "j10", "j11"];
  var G9 = ["j12", "j13", "j14", "j15", "j16", "j17", "j18", "j19", "j20", "j21"];
  var REVIEW = ["j22", "j23", "j24", "j25", "j26", "j27", "j28", "j29", "j30", "j31", "j32", "j33"];
  var SPRINT = ["j34", "j35", "j36", "j37"];

  return {
    key: "physics",
    stage: "junior",
    stageName: "初中",
    name: "物理",
    fullScore: 100,
    /** 初中物理 100 分制（中考有的地区 70/80/100，老师可自己改这一行） */
    bands: [
      { min: 85, key: 3, name: "冲高分" },
      { min: 55, key: 2, name: "提中档" },
      { min: 0, key: 1, name: "补基础" }
    ],
    stages: STAGES,
    modules: MODULES,
    grades: {
      // ⭐ 选年级就只看到该年级的模块（"宁多勿少"：库装全，靠年级表来筛）
      "八年级": G8A.concat(G8B),
      "八年级上": G8A.slice(),
      "八年级下": G8B.slice(),
      "九年级": G9.concat(REVIEW, SPRINT),
      "九年级上": G9.concat(SPRINT),
      "中考冲刺": REVIEW.concat(SPRINT)
    },
    books: ["人教版", "人教版（2024）", "其他版本"]
  };
}));
