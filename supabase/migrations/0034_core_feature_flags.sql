-- 0034: 核心功能开关种子（只补数据，不改表结构）
insert into public.feature_flags (key, enabled)
values
  ('paper_analysis', true),
  ('math_plan', true),
  ('plan_generator', true),
  ('ai_analysis', true),
  ('batch_import', true)
on conflict (key) do nothing;
