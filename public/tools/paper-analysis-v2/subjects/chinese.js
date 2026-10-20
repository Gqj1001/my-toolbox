/**
 * 科目包：语文（高中 / 初中）
 * 语文特有：题号常带小问；写作有分项（内容/结构/语言）；一篇材料带多题。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PaperV2SubjectPacks = Object.assign(root.PaperV2SubjectPacks || {}, factory());
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const modules = [
    { id: 'modern', name: '现代文阅读', re: /现代文|信息类|文学类|论述类|实用类|小说|散文|新闻|传记/i, advice: '先圈题干关键词，再回原文定位；答案按"观点 + 原文依据 + 分析"三层写。' },
    { id: 'classical', name: '文言文阅读', re: /文言|实词|虚词|断句|翻译|古代文化常识|史传/i, advice: '文言文先通读抓人物与事件，再逐句翻译；实词/虚词按"课内例句"回扣。' },
    { id: 'poetry', name: '古代诗歌阅读', re: /诗歌|词|曲|意象|意境|表达技巧|炼字|情感/i, advice: '诗歌先看标题/作者/注释，再抓意象与情感词；手法题要写"手法 + 诗句 + 效果"。' },
    { id: 'dictation', name: '名篇名句默写', re: /默写|名篇名句|背诵|补写/i, advice: '默写按"篇目 + 易错字"清单滚动复习，错字单独抄三遍。' },
    { id: 'language', name: '语言文字运用', re: /语用|成语|病句|衔接|补写|修辞|标点|压缩语段/i, advice: '语用题先判断考点（成语/病句/衔接/补写），再按"排除法 + 证据"作答。' },
    { id: 'writing', name: '写作', re: /写作|作文|议论文|记叙文|任务驱动/i, advice: '写作先列提纲（中心论点/分论点/素材），再写完整段；分项检查内容、结构、语言。' },
    { id: 'foundation', name: '基础积累', re: /字音|字形|词语|文学常识|名著/i, advice: '基础题按"每天一页"积累，错题按字音/字形/词语分类。' },
  ];

  const senior = {
    key: 'chinese', stage: 'senior', name: '语文', fullScore: 150,
    types: [
      { id: 'modern', label: '现代文阅读', aliases: ['信息类文本阅读', '文学类文本阅读', '论述类文本阅读', '实用类文本阅读', '现代文'], per: 5 },
      { id: 'classical', label: '文言文阅读', aliases: ['文言文', '古代文言', '文言'], per: 4 },
      { id: 'poetry', label: '古代诗歌阅读', aliases: ['古代诗歌', '诗歌鉴赏', '古诗'], per: 4.5 },
      { id: 'dictation', label: '名篇名句默写', aliases: ['默写', '名句默写', '名篇名句'], per: 2 },
      { id: 'language', label: '语言文字运用', aliases: ['语用', '语言文字', '语言运用'], per: 4 },
      { id: 'writing', label: '写作', aliases: ['作文', '写作题', '大作文'], per: 60, absorb: true, parts: ['内容', '结构', '语言'] },
    ],
    presets: [
      { name: '新高考语文（150分）', total: 150, dist: { 现代文阅读: [7, 5, 35], 文言文阅读: [5, 4, 20], 古代诗歌阅读: [2, 4.5, 9], 名篇名句默写: [3, 2, 6], 语言文字运用: [5, 4, 20], 写作: [1, 60, 60] } },
    ],
    modules,
    kpDict: {
      '现代文阅读': 'modern', '信息类文本': 'modern', '文学类文本': 'modern', '小说': 'modern', '散文': 'modern',
      '文言文阅读': 'classical', '实词': 'classical', '虚词': 'classical', '断句': 'classical', '翻译': 'classical',
      '古代诗歌': 'poetry', '诗歌鉴赏': 'poetry', '意象': 'poetry', '表达技巧': 'poetry',
      '名篇名句默写': 'dictation', '默写': 'dictation',
      '语言文字运用': 'language', '成语': 'language', '病句': 'language', '衔接': 'language',
      '写作': 'writing', '作文': 'writing', '议论文': 'writing',
    },
    bands: { 1: ['dictation', 'foundation', 'language'], 2: ['classical', 'poetry'], 3: ['modern', 'writing'] },
    prompts: { persona: '你是一位有十几年经验的高中语文教师', knowledgeHint: '用「论证思路」「文言实词」「意象」这类教材措辞' },
    grades: ['高一', '高二', '高三'],
    defaultGrade: '高三',
    otherAdvice: '先保默写/语用等"可拿分"的题，再练阅读答题规范与作文结构；每道错题写清"是没读懂还是没按题型答"。',
  };

  const junior = {
    key: 'chinese', stage: 'junior', name: '语文', fullScore: 120,
    types: [
      { id: 'modern', label: '现代文阅读', aliases: ['记叙文阅读', '说明文阅读', '议论文阅读', '现代文'], per: 5 },
      { id: 'classical', label: '文言文阅读', aliases: ['文言文', '文言'], per: 3.75 },
      { id: 'poetry', label: '古代诗歌阅读', aliases: ['诗歌鉴赏', '古诗'], per: 3 },
      { id: 'dictation', label: '名篇名句默写', aliases: ['默写', '名句默写'], per: 1 },
      { id: 'language', label: '语言文字运用', aliases: ['语用', '语言运用'], per: 3.5 },
      { id: 'writing', label: '写作', aliases: ['作文', '写作题'], per: 50, absorb: true, parts: ['内容', '结构', '语言'] },
    ],
    presets: [
      { name: '中考语文（120分）', total: 120, dist: { 现代文阅读: [6, 5, 30], 文言文阅读: [4, 3.75, 15], 古代诗歌阅读: [2, 3, 6], 名篇名句默写: [5, 1, 5], 语言文字运用: [4, 3.5, 14], 写作: [1, 50, 50] } },
    ],
    modules,
    kpDict: {
      '现代文阅读': 'modern', '记叙文': 'modern', '说明文': 'modern', '议论文': 'modern',
      '文言文阅读': 'classical', '实词': 'classical', '翻译': 'classical',
      '诗歌鉴赏': 'poetry', '名句默写': 'dictation', '语言文字运用': 'language', '写作': 'writing',
    },
    bands: { 1: ['dictation', 'foundation', 'language'], 2: ['classical', 'poetry'], 3: ['modern', 'writing'] },
    prompts: { persona: '你是一位有十几年经验的初中语文教师', knowledgeHint: '用「记叙文六要素」「文言实词」这类教材措辞' },
    grades: ['七年级', '八年级', '九年级'],
    defaultGrade: '九年级',
    otherAdvice: '先保默写与基础题，再练阅读答题格式与作文；错题按"基础/阅读/写作"三类归档。',
  };

  return { 'chinese-senior': senior, 'chinese-junior': junior };
}));
