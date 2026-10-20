/**
 * 科目包：英语（高中 / 初中）
 * 英语特有：听力「难度不估」；书面表达有分项（内容/结构/语言）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperV2SubjectPacks = Object.assign(root.PaperV2SubjectPacks || {}, factory());
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const modules = [
    { id: 'listening', name: '听力', re: /听力|听辨|对话|独白|听写/i, advice: '每天 10–15 分钟精听：先抓关键词，再核对原文；错题标出"没听清"还是"没理解"。' },
    { id: 'reading', name: '阅读理解', re: /阅读|主旨|细节|推断|词义猜测|篇章/i, advice: '阅读先看题干定位段落，再比对选项；每道错题写清"定位错/理解错/被干扰项骗"。' },
    { id: 'seven', name: '七选五', re: /七选五|语篇|衔接|连贯/i, advice: '七选五先看空格前后句的逻辑关系（转折/因果/举例），再用代词与关键词回填。' },
    { id: 'cloze', name: '完形填空', re: /完形|完型|语境|词义辨析/i, advice: '完形先通读全文抓主线，再逐空看搭配与上下文；不要只看单句。' },
    { id: 'grammar', name: '语法填空', re: /语法填空|时态|语态|非谓语|从句|冠词|介词|词形/i, advice: '语法填空先判断考点（时态/非谓语/从句/词形），再写答案；每道错题记一条规则。' },
    { id: 'writing', name: '书面表达', re: /写作|书面表达|应用文|读后续写|作文/i, advice: '写作先列提纲（要点/结构/连接词），再写完整句；分项检查内容、结构、语言。' },
    { id: 'vocab', name: '词汇与基础', re: /词汇|单词|短语|拼写|词性/i, advice: '词汇按"高频词+熟词生义"分组记，每天滚动复习；拼写错误单独建清单。' },
  ];

  const seniorTypes = [
    { id: 'listening', label: '听力', aliases: ['听力理解', '听力第一节', '听力第二节', '听写'], per: 1.5, noDifficulty: true },
    { id: 'reading', label: '阅读理解', aliases: ['阅读', '阅读第一节', '阅读第二节'], per: 2.5 },
    { id: 'seven', label: '七选五', aliases: ['七选五阅读', '阅读七选五'], per: 2.5 },
    { id: 'cloze', label: '完形填空', aliases: ['完形', '完型填空', '完型'], per: 1 },
    { id: 'grammar', label: '语法填空', aliases: ['语法', '语法填空（含词形变化）'], per: 1.5 },
    { id: 'writing', label: '书面表达', aliases: ['写作', '应用文写作', '读后续写', '作文'], per: 20, absorb: true, parts: ['内容', '结构', '语言'] },
  ];

  const senior = {
    key: 'english', stage: 'senior', name: '英语', fullScore: 150,
    types: seniorTypes,
    presets: [
      { name: '新高考英语（150分）', total: 150, dist: { 听力: [20, 1.5], 阅读理解: [15, 2.5], 七选五: [5, 2.5], 完形填空: [15, 1], 语法填空: [10, 1.5], 书面表达: [2, 20] } },
    ],
    modules,
    kpDict: {
      '听力理解': 'listening', '听力细节': 'listening',
      '阅读理解': 'reading', '主旨大意': 'reading', '推理判断': 'reading', '词义猜测': 'reading',
      '七选五': 'seven', '语篇衔接': 'seven',
      '完形填空': 'cloze', '词义辨析': 'cloze',
      '语法填空': 'grammar', '时态': 'grammar', '非谓语动词': 'grammar', '定语从句': 'grammar',
      '书面表达': 'writing', '应用文写作': 'writing', '读后续写': 'writing',
      '词汇': 'vocab', '短语搭配': 'vocab',
    },
    bands: { 1: ['vocab', 'grammar'], 2: ['reading', 'cloze'], 3: ['writing', 'seven', 'listening'] },
    prompts: { persona: '你是一位有十几年经验的高中英语教师', knowledgeHint: '用「非谓语动词」「主旨大意」这类教材措辞' },
    grades: ['高一', '高二', '高三'],
    defaultGrade: '高三',
    otherAdvice: '先把词汇与语法基础补稳，再练阅读与写作；每道错题写清"是词不会、句没读懂，还是方法不对"。',
    noDifficultyTypes: ['听力'],
  };

  const junior = {
    key: 'english', stage: 'junior', name: '英语', fullScore: 120,
    types: [
      { id: 'listening', label: '听力', aliases: ['听力理解', '听力'], per: 1, noDifficulty: true },
      { id: 'reading', label: '阅读理解', aliases: ['阅读'], per: 2 },
      { id: 'seven', label: '七选五', aliases: ['七选五阅读'], per: 2 },
      { id: 'cloze', label: '完形填空', aliases: ['完形', '完型填空'], per: 1 },
      { id: 'grammar', label: '语法填空', aliases: ['语法', '语法填空'], per: 1 },
      { id: 'vocab', label: '词汇运用', aliases: ['单词拼写', '词汇'], per: 2 },
      { id: 'writing', label: '书面表达', aliases: ['写作', '作文'], per: 20, absorb: true, parts: ['内容', '结构', '语言'] },
    ],
    presets: [
      { name: '中考英语（120分）', total: 120, dist: { 听力: [20, 1], 阅读理解: [15, 2], 七选五: [5, 2], 完形填空: [10, 1], 语法填空: [10, 1], 词汇运用: [10, 2], 书面表达: [1, 20] } },
    ],
    modules,
    kpDict: {
      '听力': 'listening', '阅读理解': 'reading', '七选五': 'seven', '完形填空': 'cloze',
      '语法填空': 'grammar', '词汇运用': 'vocab', '书面表达': 'writing',
      '一般现在时': 'grammar', '一般过去时': 'grammar', '宾语从句': 'grammar', '被动语态': 'grammar',
    },
    bands: { 1: ['vocab', 'grammar'], 2: ['reading', 'cloze'], 3: ['writing', 'listening'] },
    prompts: { persona: '你是一位有十几年经验的初中英语教师', knowledgeHint: '用「宾语从句」「一般过去时」这类教材措辞' },
    grades: ['七年级', '八年级', '九年级'],
    defaultGrade: '九年级',
    otherAdvice: '先把单词和基础语法过关，再练阅读与写作；错题按"词/句/方法"三类归档。',
    noDifficultyTypes: ['听力'],
  };

  return { 'english-senior': senior, 'english-junior': junior };
}));
