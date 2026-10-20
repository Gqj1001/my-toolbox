-- ============================================================
-- 0023 试用会员触发器的**运行期自检**（不会留下任何数据）
-- ----------------------------------------------------------------------------
-- 跑法：Supabase → SQL Editor → 新建查询 → 把本文件整段粘贴 → Run。
--
-- 它在一个事务里：
--   1. 往 auth.users 插一个临时用户（用 example.com，不会发邮件）；
--   2. 等触发器自动往 public.user_roles 插一行；
--   3. 检查 plan=vip / status=active / expires_at≈15 天后；
--   4. ROLLBACK —— 临时用户和 user_roles 行都不会留下。
--
-- 成功时最后一条消息是：
--   NOTICE:  OK：新用户自动获得 vip / active / 15 天
-- 失败时 RAISE EXCEPTION 会说明是哪一项不对（事务不会提交）。
--
-- ⚠️ 如果中途报错，事务是“已中止”状态，不会写进任何数据；
--    再执行一句 `rollback;` 即可（或者直接关掉这个查询页）。
-- ============================================================

begin;

do $$
declare
  v_id      uuid := gen_random_uuid();
  v_email   text := 'trial-vip-check-' || extract(epoch from now())::bigint || '@example.com';
  v_plan    text;
  v_status  text;
  v_expires timestamptz;
  v_days    numeric;
begin
  -- 尽量把 auth.users 的常见非空列都填上（不同 Supabase 版本的列默认值略有差异）。
  -- 这一步会触发 on_auth_user_created_grant_trial_vip。
  insert into auth.users (
    id, instance_id, aud, role, email,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  )
  values (
    v_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    v_email,
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

  select plan, status, expires_at
    into v_plan, v_status, v_expires
  from public.user_roles
  where user_id = v_id;

  if not found then
    raise exception 'FAIL：触发器没有为新用户建 user_roles 行（检查触发器是否存在、是否报 warning）';
  end if;

  if v_plan is distinct from 'vip' then
    raise exception 'FAIL：plan=%（应为 vip）', v_plan;
  end if;

  if v_status is distinct from 'active' then
    raise exception 'FAIL：status=%（应为 active）', v_status;
  end if;

  if v_expires is null then
    raise exception 'FAIL：expires_at 是 null';
  end if;

  v_days := extract(epoch from (v_expires - now())) / 86400.0;

  if v_days < 14.9 or v_days > 15.1 then
    raise exception 'FAIL：expires_at 距现在 % 天（应约 15 天）', round(v_days, 2);
  end if;

  raise notice 'OK：新用户自动获得 vip / active / % 天', round(v_days, 2);
end
$$;

-- 关键：不提交。临时 auth 用户与 user_roles 行都会被回滚掉。
rollback;
