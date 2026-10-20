/**
 * 科目包：数学（高中 / 初中）
 * 纯配置，不含流程逻辑；核心引擎在 ../../paper-analysis/js/core/subject-engine.js
 * 加学科 = 加一个这样的文件 + manifest 里加一行。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../../paper-analysis/js/core/knowledge-classifier.js'),
      require('../../paper-analysis/js/core/kp-dict.js'),
    );
  } else {
    root.PaperV2SubjectPacks = Object.assign(root.PaperV2SubjectPacks || {}, factory(root.KnowledgeClassifier, root.KpDict));
  }
}(typeof self !== 'undefined' ? self : this, function (KC, KpDict) {
  'use strict';

  const modules = (KC && KC.MODULES ? KC.MODULES : []).map((m) => ({
    id: m.id,
    name: m.name,
    re: m.re,
    advice: (KC.ADVICE && KC.ADVICE[m.name]) || '把这一模块的核心概念与常考题型逐条过关，再做同类题巩固。',
  }));

  const base = {
    key: 'math',
    name: '数学',
    fullScore: 150,
    types: [
      { id: 'single', label: '单选题', aliases: ['选择题', '单选', '单项选择'], per: 5 },
      { id: 'multi', label: '多选题', aliases: ['多选', '多项选择', '不定项选择'], per: 6 },
      { id: 'fill', label: '填空题', aliases: ['填空'], per: 5 },
      { id: 'calc', label: '解答题', aliases: ['计算题', '大题', '解答'], per: 12, absorb: true },
    ],
    presets: [
      { name: '新高考 I/II 卷', total: 150, dist: { 单选题: [8, 5], 多选题: [3, 6], 填空题: [3, 5], 解答题: [5, 15.4, 77] } },
      { name: '北京卷', total: 150, dist: { 单选题: [10, 4], 填空题: [5, 5], 解答题: [6, 14.17, 85] } },
    ],
    modules,
    kpDict: KpDict || null,
    bands: { 1: ['trig', 'func', 'seq'], 2: ['solid', 'prob', 'vector'], 3: ['analytic', 'deriv', 'ineq'] },
    prompts: {
      persona: '你是一位有十几年经验的高中数学教师',
      knowledgeHint: '用「函数的单调性」「直线与圆锥曲线」这类教材措辞',
    },
    grades: ['高一', '高二', '高三'],
    defaultGrade: '高三',
    otherAdvice: '先把基础题的正确率稳住，再攻中档题；每道错题都要写清"卡在哪一步"。',
  };

  const junior = Object.assign({}, base, {
    stage: 'junior',
    fullScore: 120,
    types: [
      { id: 'single', label: '单选题', aliases: ['选择题', '单选'], per: 3 },
      { id: 'fill', label: '填空题', aliases: ['填空'], per: 3 },
      { id: 'calc', label: '解答题', aliases: ['计算题', '大题'], per: 8, absorb: true },
    ],
    presets: [
      { name: '中考数学（120分）', total: 120, dist: { 单选题: [10, 3], 填空题: [6, 3], 解答题: [8, 7.5, 72] } },
    ],
    grades: ['七年级', '八年级', '九年级'],
    defaultGrade: '九年级',
    prompts: { persona: '你是一位有十几年经验的初中数学教师', knowledgeHint: '用「一元二次方程」「全等三角形」这类教材措辞' },
  });

  const senior = Object.assign({}, base, { stage: 'senior' });
  return { 'math-senior': senior, 'math-junior': junior };
}));
