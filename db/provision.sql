\set ON_ERROR_STOP on
BEGIN;
SELECT pg_advisory_xact_lock(691064);
SELECT set_config('eclipse.app_new', :'app_new_initial', true),
       set_config('eclipse.migrator_new', :'migrator_new_initial', true),
       set_config('eclipse.expected_migrations', :'expected_migrations', true);

-- Refuse unknown roles, memberships, schemas, objects and migration history before changing anything.
DO $$
DECLARE role_record record;
        migration_count integer := 0;
BEGIN
  IF current_user <> 'eclipse_bootstrap' OR current_database() <> 'eclipse' THEN
    RAISE EXCEPTION 'unexpected bootstrap identity';
  END IF;
  IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) <> 'eclipse_bootstrap'
     OR (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') NOT IN ('pg_database_owner','eclipse_bootstrap') THEN
    RAISE EXCEPTION 'unexpected database or public schema ownership';
  END IF;
  IF (NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eclipse_app'))::text <> current_setting('eclipse.app_new')
    OR (NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eclipse_migrator'))::text <> current_setting('eclipse.migrator_new') THEN
    RAISE EXCEPTION 'roles changed during preflight';
  END IF;
  FOR role_record IN SELECT * FROM pg_roles WHERE rolname IN ('eclipse_app', 'eclipse_migrator') LOOP
    IF shobj_description(role_record.oid, 'pg_authid') IS DISTINCT FROM 'Eclipse Crew TASK-064 managed role'
       OR NOT role_record.rolcanlogin OR role_record.rolsuper OR role_record.rolcreatedb OR role_record.rolcreaterole OR role_record.rolreplication OR role_record.rolbypassrls
       OR EXISTS (SELECT FROM pg_auth_members WHERE member = role_record.oid OR roleid = role_record.oid) THEN
      RAISE EXCEPTION 'incompatible existing role';
    END IF;
  END LOOP;
  IF EXISTS (SELECT FROM pg_default_acl d JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
      WHERE owner_role.rolname IN ('eclipse_bootstrap','eclipse_migrator','eclipse_app')
        AND (d.defaclnamespace = 0 OR d.defaclnamespace IN (SELECT oid FROM pg_namespace WHERE nspname IN ('public','drizzle')))) THEN
    RAISE EXCEPTION 'unexpected default privileges';
  END IF;
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname NOT IN ('public','drizzle','information_schema')
      AND nspname NOT LIKE 'pg\_%' ESCAPE '\') THEN
    RAISE EXCEPTION 'unrelated schema';
  END IF;
  IF EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') OR
     EXISTS (SELECT FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typrelid = 0 AND t.typelem = 0) THEN
    RAISE EXCEPTION 'unrelated public function or type';
  END IF;
  IF EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f') AND c.relname NOT IN ('owner','sessions','agents','agent_policies','chat_sessions','messages','providers','model_roles')) THEN
    RAISE EXCEPTION 'unrelated public object';
  END IF;
  IF EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'i' AND c.relname NOT IN ('owner_pkey','owner_login_unique','owner_singleton_idx','sessions_pkey','sessions_token_hash_unique','sessions_owner_id_idx','sessions_expires_at_idx','agents_pkey','agents_owner_id_idx','agent_policies_pkey','agent_policies_owner_id_idx','chat_sessions_pkey','chat_sessions_owner_id_idx','chat_sessions_owner_agent_idx','messages_pkey','messages_owner_id_idx','messages_session_created_idx','messages_run_id_idx','providers_pkey','providers_owner_id_idx','model_roles_pkey','model_roles_owner_id_idx','model_roles_provider_id_idx','model_roles_owner_role_idx')) OR
     EXISTS (SELECT FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','drizzle') AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'unexpected index or trigger';
  END IF;
  IF EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles o ON o.oid = c.relowner WHERE n.nspname = 'public' AND c.relname IN ('owner','sessions','agents','agent_policies','chat_sessions','messages','providers','model_roles')
      AND (c.relkind <> 'r' OR o.rolname NOT IN ('eclipse_bootstrap','eclipse_migrator'))) THEN
    RAISE EXCEPTION 'incompatible owner table';
  END IF;
  IF EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public' AND c.relname IN ('owner','sessions','agents','agent_policies','chat_sessions','messages','providers','model_roles') AND a.grantee <> c.relowner
        AND NOT (COALESCE(a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'eclipse_app'), false)
                 AND ((c.relname IN ('owner','agent_policies','model_roles') AND a.privilege_type IN ('SELECT','INSERT','UPDATE'))
                   OR (c.relname IN ('sessions','agents','providers') AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))
                   OR (c.relname IN ('chat_sessions','messages') AND a.privilege_type IN ('SELECT','INSERT')))
                 AND NOT a.is_grantable)) THEN
    RAISE EXCEPTION 'unexpected owner table grants';
  END IF;
  IF to_regclass('public.owner') IS NOT NULL AND
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.owner') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','login','password_hash','timezone','created_at'] THEN
    RAISE EXCEPTION 'unexpected owner table columns';
  END IF;
  IF to_regclass('public.owner') IS NOT NULL AND
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.owner') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','text','text','text','timestamp with time zone'] THEN
    RAISE EXCEPTION 'unexpected owner table types';
  END IF;
  IF to_regclass('public.owner') IS NOT NULL AND (
      EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.owner')
        AND attnum > 0 AND NOT attisdropped AND NOT attnotnull) OR
      (SELECT array_agg(conname::text ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.owner'))
        IS DISTINCT FROM ARRAY['owner_id_matches_id','owner_login_unique','owner_pkey'] OR
      (SELECT array_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.owner'))
        IS DISTINCT FROM ARRAY['CHECK ((owner_id = id))','UNIQUE (login)','PRIMARY KEY (id)'] OR
      (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = to_regclass('public.owner')
        AND adnum = 6) IS DISTINCT FROM 'now()') THEN
    RAISE EXCEPTION 'unexpected owner table constraints';
  END IF;
  IF to_regclass('public.sessions') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.sessions') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','token_hash','csrf_token','created_at','expires_at','last_active'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.sessions') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','text','text','timestamp with time zone','timestamp with time zone','timestamp with time zone'] OR
      EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.sessions')
        AND attnum > 0 AND NOT attisdropped AND NOT attnotnull) OR
      EXISTS (SELECT FROM pg_index WHERE indrelid = to_regclass('public.sessions') AND (NOT indisvalid OR NOT indisready)) OR
      (SELECT array_agg(conname::text ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.sessions'))
        IS DISTINCT FROM ARRAY['sessions_pkey','sessions_token_hash_unique'] OR
      (SELECT array_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.sessions'))
        IS DISTINCT FROM ARRAY['PRIMARY KEY (id)','UNIQUE (token_hash)'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.sessions'))
        IS DISTINCT FROM ARRAY[5,7] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.sessions') AND pg_get_expr(adbin, adrelid) <> 'now()') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'sessions')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at)',
          'CREATE INDEX sessions_owner_id_idx ON public.sessions USING btree (owner_id)',
          'CREATE UNIQUE INDEX sessions_pkey ON public.sessions USING btree (id)',
          'CREATE UNIQUE INDEX sessions_token_hash_unique ON public.sessions USING btree (token_hash)']) THEN
    RAISE EXCEPTION 'unexpected sessions schema';
  END IF;
  IF to_regclass('public.agents') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.agents') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','name','role','soul_md','status','daily_budget_cents','monthly_budget_cents','created_at','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.agents') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','text','text','text','text','integer','integer','timestamp with time zone','timestamp with time zone'] OR
      EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents')
        AND attnum > 0 AND NOT attisdropped AND NOT attnotnull) OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.agents'))
        IS DISTINCT FROM ARRAY[
          'agents_daily_budget_check=CHECK (((daily_budget_cents >= 1) AND (daily_budget_cents <= 100000000)))',
          'agents_monthly_budget_check=CHECK (((monthly_budget_cents >= 1) AND (monthly_budget_cents <= 100000000)))',
          'agents_pkey=PRIMARY KEY (id)',
          'agents_status_check=CHECK ((status = ANY (ARRAY[''active''::text, ''paused''::text])))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.agents'))
        IS DISTINCT FROM ARRAY[6,9,10] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.agents') AND pg_get_expr(adbin, adrelid) <> 'now()' AND adnum <> 6) OR
      (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = to_regclass('public.agents') AND adnum = 6)
        IS DISTINCT FROM '''paused''::text' OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'agents')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX agents_owner_id_idx ON public.agents USING btree (owner_id)',
          'CREATE UNIQUE INDEX agents_pkey ON public.agents USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected agents schema';
  END IF;
  IF to_regclass('public.agent_policies') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.agent_policies') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['agent_id','owner_id','tools','domains','actions','memory_scopes','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.agent_policies') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','text[]','text[]','text[]','text[]','timestamp with time zone'] OR
      EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agent_policies')
        AND attnum > 0 AND NOT attisdropped AND NOT attnotnull) OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.agent_policies'))
        IS DISTINCT FROM ARRAY[
          'agent_policies_actions_check=CHECK ((cardinality(actions) <= 64))',
          'agent_policies_agent_id_agents_id_fk=FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE',
          'agent_policies_domains_check=CHECK ((cardinality(domains) <= 64))',
          'agent_policies_memory_scopes_check=CHECK ((cardinality(memory_scopes) <= 3))',
          'agent_policies_pkey=PRIMARY KEY (agent_id)',
          'agent_policies_tools_check=CHECK ((cardinality(tools) <= 64))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.agent_policies'))
        IS DISTINCT FROM ARRAY[3,4,5,6,7] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.agent_policies') AND adnum BETWEEN 3 AND 6
        AND pg_get_expr(adbin, adrelid) <> '''{}''::text[]') OR
      (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = to_regclass('public.agent_policies') AND adnum = 7)
        IS DISTINCT FROM 'now()' OR
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = to_regclass('public.agent_policies') AND conname = 'agent_policies_agent_id_agents_id_fk')
        IS DISTINCT FROM 'FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE' OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'agent_policies')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX agent_policies_owner_id_idx ON public.agent_policies USING btree (owner_id)',
          'CREATE UNIQUE INDEX agent_policies_pkey ON public.agent_policies USING btree (agent_id)']) THEN
    RAISE EXCEPTION 'unexpected agent policies schema';
  END IF;
  IF to_regclass('public.chat_sessions') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.chat_sessions') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','agent_id','created_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.chat_sessions') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','timestamp with time zone'] OR
      EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.chat_sessions')
        AND attnum > 0 AND NOT attisdropped AND NOT attnotnull) OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.chat_sessions'))
        IS DISTINCT FROM ARRAY[
          'chat_sessions_agent_id_agents_id_fk=FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE',
          'chat_sessions_pkey=PRIMARY KEY (id)'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.chat_sessions'))
        IS DISTINCT FROM ARRAY[4] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.chat_sessions') AND pg_get_expr(adbin, adrelid) <> 'now()') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'chat_sessions')
        IS DISTINCT FROM ARRAY[
          'CREATE UNIQUE INDEX chat_sessions_owner_agent_idx ON public.chat_sessions USING btree (owner_id, agent_id)',
          'CREATE INDEX chat_sessions_owner_id_idx ON public.chat_sessions USING btree (owner_id)',
          'CREATE UNIQUE INDEX chat_sessions_pkey ON public.chat_sessions USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected chat sessions schema';
  END IF;
  IF to_regclass('public.messages') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.messages') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','session_id','role','card_type','content','source_tag','run_id','created_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.messages') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','text','text','jsonb','text','uuid','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.messages') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,true,true,true,false,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.messages'))
        IS DISTINCT FROM ARRAY[
          'messages_card_type_check=CHECK ((card_type = ANY (ARRAY[''message''::text, ''clarification''::text, ''tool_connection''::text, ''routine''::text])))',
          'messages_pkey=PRIMARY KEY (id)',
          'messages_role_check=CHECK ((role = ANY (ARRAY[''user''::text, ''agent''::text, ''system''::text])))',
          'messages_session_id_chat_sessions_id_fk=FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE',
          'messages_source_tag_check=CHECK ((source_tag = ANY (ARRAY[''user''::text, ''agent''::text, ''tool''::text, ''system''::text])))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.messages'))
        IS DISTINCT FROM ARRAY[9] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.messages') AND pg_get_expr(adbin, adrelid) <> 'now()') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'messages')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX messages_owner_id_idx ON public.messages USING btree (owner_id)',
          'CREATE UNIQUE INDEX messages_pkey ON public.messages USING btree (id)',
          'CREATE INDEX messages_run_id_idx ON public.messages USING btree (run_id)',
          'CREATE INDEX messages_session_created_idx ON public.messages USING btree (session_id, created_at, id)']) THEN
    RAISE EXCEPTION 'unexpected messages schema';
  END IF;
  IF to_regclass('public.providers') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.providers') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','kind','base_url','encrypted_key','key_hint','enabled','created_at','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.providers') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','text','text','text','text','boolean','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.providers') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,false,false,false,true,true,true] OR
      (SELECT array_agg(conname::text ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.providers'))
        IS DISTINCT FROM ARRAY['providers_kind_check','providers_pkey'] OR
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = to_regclass('public.providers') AND conname = 'providers_kind_check')
        IS DISTINCT FROM 'CHECK ((kind = ANY (ARRAY[''meta''::text, ''openai-compatible''::text])))' OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.providers'))
        IS DISTINCT FROM ARRAY[7,8,9] OR
      EXISTS (SELECT FROM pg_attrdef d WHERE d.adrelid = to_regclass('public.providers')
        AND ((d.adnum = 7 AND pg_get_expr(d.adbin, d.adrelid) <> 'true')
          OR (d.adnum IN (8,9) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()'))) OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'providers')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX providers_owner_id_idx ON public.providers USING btree (owner_id)',
          'CREATE UNIQUE INDEX providers_pkey ON public.providers USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected providers schema';
  END IF;
  IF to_regclass('public.model_roles') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.model_roles') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','role','provider_id','model','use_main_key','mode','created_at','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.model_roles') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','text','uuid','text','boolean','text','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.model_roles') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,false,false,true,true,true,true] OR
      (SELECT array_agg(conname::text || ': ' || pg_get_constraintdef(oid) ORDER BY conname)
       FROM pg_constraint WHERE conrelid = to_regclass('public.model_roles'))
        IS DISTINCT FROM ARRAY[
          'model_roles_main_shape_check: CHECK (((role <> ''main''::text) OR ((mode = ''active''::text) AND (provider_id IS NOT NULL) AND (model IS NOT NULL) AND (use_main_key = false))))',
          'model_roles_mode_check: CHECK ((mode = ANY (ARRAY[''active''::text, ''off''::text, ''meta''::text])))',
          'model_roles_pkey: PRIMARY KEY (id)',
          'model_roles_provider_id_providers_id_fk: FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE RESTRICT',
          'model_roles_role_check: CHECK ((role = ANY (ARRAY[''main''::text, ''sam''::text])))',
          'model_roles_sam_shape_check: CHECK (((role <> ''sam''::text) OR (((mode = ''off''::text) AND (provider_id IS NULL) AND (model IS NULL) AND (use_main_key = false)) OR ((mode = ''meta''::text) AND (provider_id IS NOT NULL) AND (model IS NOT NULL)))))'
        ] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.model_roles'))
        IS DISTINCT FROM ARRAY[6,8,9] OR
      EXISTS (SELECT FROM pg_attrdef d WHERE d.adrelid = to_regclass('public.model_roles')
        AND ((d.adnum = 6 AND pg_get_expr(d.adbin, d.adrelid) <> 'false')
          OR (d.adnum IN (8,9) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()'))) OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'model_roles')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX model_roles_owner_id_idx ON public.model_roles USING btree (owner_id)',
          'CREATE UNIQUE INDEX model_roles_owner_role_idx ON public.model_roles USING btree (owner_id, role)',
          'CREATE UNIQUE INDEX model_roles_pkey ON public.model_roles USING btree (id)',
          'CREATE INDEX model_roles_provider_id_idx ON public.model_roles USING btree (provider_id)']) THEN
    RAISE EXCEPTION 'unexpected model roles schema';
  END IF;
  IF to_regclass('public.owner') IS NOT NULL AND (
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.owner'))
        IS DISTINCT FROM ARRAY[6] OR
      EXISTS (SELECT FROM pg_index WHERE indrelid = to_regclass('public.owner') AND (NOT indisvalid OR NOT indisready)) OR
      EXISTS (SELECT FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'owner' AND indexdef NOT IN (
        'CREATE UNIQUE INDEX owner_pkey ON public.owner USING btree (id)',
        'CREATE UNIQUE INDEX owner_login_unique ON public.owner USING btree (login)',
        'CREATE UNIQUE INDEX owner_singleton_idx ON public.owner USING btree ((true))'))) THEN
    RAISE EXCEPTION 'unexpected owner indexes or defaults';
  END IF;
  IF EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND (c.relrowsecurity OR c.relforcerowsecurity)) OR
     EXISTS (SELECT FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','drizzle')) THEN
    RAISE EXCEPTION 'unexpected row security policy';
  END IF;
  IF EXISTS (SELECT FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','drizzle')
      AND a.attnum > 0 AND (a.attacl IS NOT NULL OR a.attidentity <> '' OR a.attgenerated <> '')) OR
     EXISTS (SELECT FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','drizzle')) THEN
    RAISE EXCEPTION 'unexpected column privileges, generated columns or rules';
  END IF;
  IF EXISTS (SELECT FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
      WHERE n.nspname = 'drizzle' AND r.rolname NOT IN ('eclipse_bootstrap','eclipse_migrator')) OR
     EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'drizzle'
      AND (c.relname NOT IN ('__drizzle_migrations','__drizzle_migrations_id_seq','__drizzle_migrations_pkey')
           OR r.rolname NOT IN ('eclipse_bootstrap','eclipse_migrator'))) THEN
    RAISE EXCEPTION 'incompatible migration schema';
  END IF;
  IF EXISTS (SELECT FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
      WHERE n.nspname = 'drizzle' AND a.grantee <> n.nspowner) OR
     EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations' AND a.grantee <> c.relowner) THEN
    RAISE EXCEPTION 'unexpected migration grants';
  END IF;
  IF EXISTS (SELECT FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner
      WHERE n.nspname = 'drizzle' AND r.rolname = 'eclipse_bootstrap')
      AND to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION 'unmanaged migration schema';
  END IF;
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    IF (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = to_regclass('drizzle.__drizzle_migrations') AND attnum > 0 AND NOT attisdropped)
       IS DISTINCT FROM ARRAY['id','hash','created_at'] THEN
      RAISE EXCEPTION 'unexpected migration table columns';
    END IF;
    SELECT count(*) INTO migration_count FROM drizzle.__drizzle_migrations;
    IF migration_count > jsonb_array_length(current_setting('eclipse.expected_migrations')::jsonb) OR
       EXISTS (SELECT FROM drizzle.__drizzle_migrations m WHERE NOT EXISTS (
         SELECT FROM jsonb_to_recordset(current_setting('eclipse.expected_migrations')::jsonb)
           AS e(idx integer, created_at bigint, hash_lf text, hash_crlf text)
         WHERE e.idx < migration_count AND m.created_at = e.created_at AND m.hash IN (e.hash_lf,e.hash_crlf))) OR
       EXISTS (SELECT FROM jsonb_to_recordset(current_setting('eclipse.expected_migrations')::jsonb)
           AS e(idx integer, created_at bigint, hash_lf text, hash_crlf text)
         WHERE e.idx < migration_count AND (SELECT count(*) FROM drizzle.__drizzle_migrations m
           WHERE m.created_at = e.created_at AND m.hash IN (e.hash_lf,e.hash_crlf)) <> 1) THEN
      RAISE EXCEPTION 'unexpected migration history';
    END IF;
    IF (migration_count >= 1) <> (to_regclass('public.owner') IS NOT NULL) OR
       (migration_count >= 2) <> (to_regclass('public.sessions') IS NOT NULL) OR
       (migration_count >= 3) <> (to_regclass('public.owner_singleton_idx') IS NOT NULL) OR
       (migration_count >= 4) <> ((to_regclass('public.agents') IS NOT NULL) AND (to_regclass('public.agent_policies') IS NOT NULL)) OR
       (migration_count >= 5) <> ((to_regclass('public.chat_sessions') IS NOT NULL) AND (to_regclass('public.messages') IS NOT NULL)) OR
       (migration_count >= 6) <> ((to_regclass('public.providers') IS NOT NULL) AND (to_regclass('public.model_roles') IS NOT NULL)) THEN
      RAISE EXCEPTION 'inconsistent migration history';
    END IF;
  ELSIF to_regclass('public.owner') IS NOT NULL OR to_regclass('public.sessions') IS NOT NULL OR
        to_regclass('public.agents') IS NOT NULL OR to_regclass('public.agent_policies') IS NOT NULL OR
        to_regclass('public.chat_sessions') IS NOT NULL OR to_regclass('public.messages') IS NOT NULL OR
        to_regclass('public.providers') IS NOT NULL OR to_regclass('public.model_roles') IS NOT NULL THEN
    RAISE EXCEPTION 'missing migration history';
  END IF;
END $$;

\if :app_new_initial
CREATE ROLE eclipse_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
COMMENT ON ROLE eclipse_app IS 'Eclipse Crew TASK-064 managed role';
\password eclipse_app
\endif
\if :migrator_new_initial
CREATE ROLE eclipse_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
COMMENT ON ROLE eclipse_migrator IS 'Eclipse Crew TASK-064 managed role';
\password eclipse_migrator
\endif

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM eclipse_app;
REVOKE TEMPORARY ON DATABASE eclipse FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE eclipse FROM eclipse_app;
REVOKE CREATE ON DATABASE eclipse FROM PUBLIC, eclipse_app;
GRANT CREATE ON DATABASE eclipse TO eclipse_migrator;
GRANT USAGE ON SCHEMA public TO eclipse_app, eclipse_migrator;
GRANT CREATE ON SCHEMA public TO eclipse_migrator;
DO $$
BEGIN
  IF to_regnamespace('drizzle') IS NULL THEN
    CREATE SCHEMA drizzle AUTHORIZATION eclipse_migrator;
  ELSE
    ALTER SCHEMA drizzle OWNER TO eclipse_migrator;
  END IF;
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    ALTER TABLE drizzle.__drizzle_migrations OWNER TO eclipse_migrator;
  END IF;
  IF to_regclass('public.owner') IS NOT NULL THEN
    ALTER TABLE public.owner OWNER TO eclipse_migrator;
    REVOKE ALL ON public.owner FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.owner TO eclipse_app;
  END IF;
  IF to_regclass('public.sessions') IS NOT NULL THEN
    ALTER TABLE public.sessions OWNER TO eclipse_migrator;
    REVOKE ALL ON public.sessions FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO eclipse_app;
  END IF;
  IF to_regclass('public.agents') IS NOT NULL THEN
    ALTER TABLE public.agents OWNER TO eclipse_migrator;
    REVOKE ALL ON public.agents FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.agents TO eclipse_app;
  END IF;
  IF to_regclass('public.agent_policies') IS NOT NULL THEN
    ALTER TABLE public.agent_policies OWNER TO eclipse_migrator;
    REVOKE ALL ON public.agent_policies FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.agent_policies TO eclipse_app;
  END IF;
  IF to_regclass('public.chat_sessions') IS NOT NULL THEN
    ALTER TABLE public.chat_sessions OWNER TO eclipse_migrator;
    REVOKE ALL ON public.chat_sessions FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.chat_sessions TO eclipse_app;
  END IF;
  IF to_regclass('public.messages') IS NOT NULL THEN
    ALTER TABLE public.messages OWNER TO eclipse_migrator;
    REVOKE ALL ON public.messages FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.messages TO eclipse_app;
  END IF;
  IF to_regclass('public.providers') IS NOT NULL THEN
    ALTER TABLE public.providers OWNER TO eclipse_migrator;
    REVOKE ALL ON public.providers FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.providers TO eclipse_app;
  END IF;
  IF to_regclass('public.model_roles') IS NOT NULL THEN
    ALTER TABLE public.model_roles OWNER TO eclipse_migrator;
    REVOKE ALL ON public.model_roles FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.model_roles TO eclipse_app;
  END IF;
END $$;
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, eclipse_app;
COMMIT;
