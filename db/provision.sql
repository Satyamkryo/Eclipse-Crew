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
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname NOT IN ('public','drizzle','pgboss','information_schema')
      AND nspname NOT LIKE 'pg\_%' ESCAPE '\') THEN
    RAISE EXCEPTION 'unrelated schema';
  END IF;
  IF to_regnamespace('pgboss') IS NOT NULL AND (
    (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'pgboss') <> 'eclipse_migrator'
    OR has_schema_privilege('eclipse_app', 'pgboss', 'CREATE')
    OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'pgboss' AND r.rolname <> 'eclipse_migrator')
  ) THEN
    RAISE EXCEPTION 'incompatible queue schema';
  END IF;
  IF EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') OR
     EXISTS (SELECT FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'public' AND t.typrelid = 0 AND t.typelem = 0) THEN
    RAISE EXCEPTION 'unrelated public function or type';
  END IF;
  IF EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f') AND c.relname NOT IN ('owner','sessions','agents','agent_policies','agent_canaries','security_events','chat_sessions','messages','providers','model_roles','runs','steps','step_evidence','checkpoints','model_prices','cost_entries','teach_recordings','routines','replay_scripts','replay_script_versions','replay_script_proposals','run_meta','skills','skill_versions','approvals','permissions','permission_uses','audit_log','memory_entries','memory_versions','memory_changes','memory_review_state','connections','github_device_flows','mcp_servers','composio_keys','composio_accounts','starter_crew_setups','starter_crew_members','crew_report_settings','crew_report_deliveries','crews','crew_members')) THEN
    RAISE EXCEPTION 'unrelated public object';
  END IF;
  IF EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'i' AND c.relname NOT IN ('owner_pkey','owner_login_unique','owner_singleton_idx','sessions_pkey','sessions_token_hash_unique','sessions_owner_id_idx','sessions_expires_at_idx','agents_pkey','agents_owner_id_idx','agent_canaries_pkey','agent_canaries_owner_id_idx','agent_canaries_sha256_idx','security_events_pkey','security_events_owner_created_idx','security_events_source_ref_unique','agent_policies_pkey','agent_policies_owner_id_idx','chat_sessions_pkey','chat_sessions_owner_id_idx','chat_sessions_owner_agent_idx','messages_pkey','messages_owner_id_idx','messages_session_created_idx','messages_run_id_idx','providers_pkey','providers_owner_id_idx','model_roles_pkey','model_roles_owner_id_idx','model_roles_provider_id_idx','model_roles_owner_role_idx','runs_pkey','runs_owner_id_idx','runs_owner_started_idx','runs_heartbeat_idx','run_meta_pkey','run_meta_owner_id_idx','run_meta_owner_execution_idx','run_meta_retry_of_idx','run_meta_parent_run_idx','steps_pkey','steps_owner_id_idx','steps_run_idx_idx','step_evidence_pkey','step_evidence_owner_id_idx','step_evidence_run_idx_idx','checkpoints_pkey','checkpoints_owner_id_idx','checkpoints_run_idx_idx','model_prices_pkey','model_prices_owner_id_idx','model_prices_provider_id_idx','model_prices_owner_provider_model_idx','cost_entries_pkey','cost_entries_owner_id_idx','cost_entries_run_id_idx','cost_entries_run_call_idx','cost_entries_idempotency_key_idx','cost_entries_capture_call_idx','cost_entries_job_call_idx','teach_recordings_pkey','teach_recordings_owner_id_idx','teach_recordings_agent_id_idx','teach_recordings_active_agent_idx','routines_pkey','routines_source_message_id_unique','routines_owner_id_idx','routines_agent_id_idx','routines_owner_next_run_idx','replay_scripts_pkey','replay_scripts_owner_id_idx','replay_scripts_agent_id_idx','replay_scripts_source_run_idx','replay_script_versions_pkey','replay_script_versions_owner_id_idx','replay_script_versions_script_id_idx','replay_script_versions_script_version_idx','replay_script_proposals_pkey','replay_script_proposals_owner_id_idx','replay_script_proposals_script_id_idx','replay_script_proposals_heal_run_idx','replay_script_proposals_pending_script_idx','skills_pkey','skills_capture_id_unique','skills_owner_id_idx','skills_agent_id_idx','skills_owner_agent_name_idx','skill_versions_pkey','skill_versions_owner_id_idx','skill_versions_skill_version_idx','approvals_pkey','approvals_owner_id_idx','permissions_pkey','permissions_owner_id_idx','permissions_active_idx','permission_uses_pkey','permission_uses_permission_used_idx','audit_log_pkey','audit_log_owner_created_idx','audit_log_owner_seq_idx','audit_log_owner_source_ref_idx','memory_entries_pkey','memory_entries_owner_id_idx','memory_entries_owner_doc_idx','memory_entries_owner_agent_idx','memory_versions_pkey','memory_versions_owner_id_idx','memory_versions_owner_doc_idx','memory_versions_owner_doc_seq_idx','memory_changes_pkey','memory_changes_owner_id_idx','memory_changes_owner_agent_idx','memory_changes_owner_state_idx','memory_review_state_pkey','memory_review_state_owner_idx','memory_versions_batch_idx','messages_search_idx','connections_pkey','connections_owner_id_idx','connections_agent_label_idx','github_device_flows_pkey','github_device_flows_owner_idx','github_device_flows_agent_idx','github_device_flows_status_idx','mcp_servers_pkey','mcp_servers_owner_id_idx','mcp_servers_agent_key_idx','composio_keys_pkey','composio_keys_owner_idx','composio_accounts_pkey','composio_accounts_owner_id_idx','composio_accounts_owner_agent_idx','composio_accounts_agent_toolkit_idx','starter_crew_setups_pkey','starter_crew_setups_owner_idx','starter_crew_members_pkey','starter_crew_members_owner_id_idx','starter_crew_members_setup_template_idx','crew_report_settings_pkey','crew_report_deliveries_pkey','crew_report_deliveries_owner_id_idx','crew_report_deliveries_owner_scheduled_idx','crews_owner_id_idx','crews_pkey','crew_members_owner_id_idx','crew_members_crew_id_idx','crew_members_crew_agent_idx','crew_members_pkey')) OR
     EXISTS (SELECT FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public','drizzle') AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'unexpected index or trigger';
  END IF;
  IF EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles o ON o.oid = c.relowner WHERE n.nspname = 'public' AND c.relname IN ('owner','sessions','agents','agent_policies','agent_canaries','security_events','chat_sessions','messages','providers','model_roles','runs','run_meta','steps','step_evidence','checkpoints','model_prices','cost_entries','teach_recordings','routines','replay_scripts','replay_script_versions','replay_script_proposals','skills','skill_versions','approvals','permissions','permission_uses','audit_log','memory_entries','memory_versions','memory_changes','memory_review_state','connections','github_device_flows','mcp_servers','composio_keys','composio_accounts','starter_crew_setups','starter_crew_members','crew_report_settings','crew_report_deliveries','crews','crew_members')
      AND (c.relkind <> 'r' OR o.rolname NOT IN ('eclipse_bootstrap','eclipse_migrator'))) THEN
    RAISE EXCEPTION 'incompatible owner table';
  END IF;
  IF EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
      WHERE n.nspname = 'public' AND c.relname IN ('owner','sessions','agents','agent_policies','agent_canaries','security_events','chat_sessions','messages','providers','model_roles','runs','run_meta','steps','step_evidence','checkpoints','model_prices','cost_entries','teach_recordings','routines','replay_scripts','replay_script_versions','replay_script_proposals','skills','skill_versions','approvals','permissions','permission_uses','audit_log','memory_entries','memory_versions','memory_changes','memory_review_state','connections','github_device_flows','mcp_servers','composio_keys','composio_accounts','starter_crew_setups','starter_crew_members','crew_report_settings','crew_report_deliveries','crews','crew_members') AND a.grantee <> c.relowner
        AND NOT (COALESCE(a.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'eclipse_app'), false)
                 AND ((c.relname IN ('owner','agent_policies','agent_canaries','model_roles') AND a.privilege_type IN ('SELECT','INSERT','UPDATE'))
                   OR (c.relname IN ('sessions','agents','providers','connections','github_device_flows','mcp_servers','composio_keys','composio_accounts') AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE'))
                   OR (c.relname IN ('memory_versions') AND a.privilege_type IN ('SELECT','INSERT'))
                   OR (c.relname IN ('memory_changes') AND a.privilege_type IN ('SELECT','INSERT','UPDATE'))
                   OR (c.relname IN ('memory_entries') AND a.privilege_type IN ('SELECT','INSERT','UPDATE'))
                   OR (c.relname = 'memory_review_state' AND a.privilege_type IN ('SELECT','INSERT','UPDATE'))
                   OR (c.relname IN ('chat_sessions','messages','security_events','steps','step_evidence','checkpoints','cost_entries','run_meta','permission_uses','audit_log') AND a.privilege_type IN ('SELECT','INSERT'))
                    OR (c.relname IN ('runs','model_prices','teach_recordings','routines','skills','approvals','permissions') AND a.privilege_type IN ('SELECT','INSERT','UPDATE'))
                    OR (c.relname IN ('replay_scripts') AND a.privilege_type IN ('SELECT','INSERT','DELETE'))
                    OR (c.relname = 'replay_script_versions' AND a.privilege_type IN ('SELECT','INSERT'))
                    OR (c.relname = 'replay_script_proposals' AND a.privilege_type IN ('SELECT','INSERT','UPDATE'))
                    OR (c.relname = 'skill_versions' AND a.privilege_type IN ('SELECT','INSERT'))
                    OR (c.relname IN ('starter_crew_setups','starter_crew_members','crew_report_settings','crew_report_deliveries','crews','crew_members') AND a.privilege_type IN ('SELECT','INSERT','UPDATE')))
                 AND NOT a.is_grantable)) THEN
    RAISE EXCEPTION 'unexpected owner table grants';
  END IF;
  IF to_regclass('public.owner') IS NOT NULL AND
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.owner') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.owner') AND attname = 'crew_stopped_at' AND NOT attisdropped)
          THEN ARRAY['id','owner_id','login','password_hash','timezone','created_at','crew_stopped_at']
          ELSE ARRAY['id','owner_id','login','password_hash','timezone','created_at'] END) THEN
    RAISE EXCEPTION 'unexpected owner table columns';
  END IF;
  IF to_regclass('public.owner') IS NOT NULL AND
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.owner') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.owner') AND attname = 'crew_stopped_at' AND NOT attisdropped)
          THEN ARRAY['uuid','uuid','text','text','text','timestamp with time zone','timestamp with time zone']
          ELSE ARRAY['uuid','uuid','text','text','text','timestamp with time zone'] END) THEN
    RAISE EXCEPTION 'unexpected owner table types';
  END IF;
  IF to_regclass('public.step_evidence') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.step_evidence') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','run_id','idx','before_hash','after_hash','width','height','sam_box','created_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.step_evidence') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','integer','text','text','integer','integer','jsonb','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.step_evidence') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,false,false,false,false,false,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.step_evidence'))
        IS DISTINCT FROM ARRAY[
          'step_evidence_pkey=PRIMARY KEY (id)',
          'step_evidence_run_id_runs_id_fk=FOREIGN KEY (run_id) REFERENCES runs(id)'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.step_evidence'))
        IS DISTINCT FROM ARRAY[10] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.step_evidence') AND pg_get_expr(adbin, adrelid) <> 'now()') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'step_evidence')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX step_evidence_owner_id_idx ON public.step_evidence USING btree (owner_id)',
          'CREATE UNIQUE INDEX step_evidence_pkey ON public.step_evidence USING btree (id)',
          'CREATE UNIQUE INDEX step_evidence_run_idx_idx ON public.step_evidence USING btree (run_id, idx)']) THEN
    RAISE EXCEPTION 'unexpected step evidence schema';
  END IF;
  IF to_regclass('public.teach_recordings') IS NULL AND to_regclass('public.model_prices') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.model_prices') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','provider_id','model','input_micro_usd_per_million','cached_micro_usd_per_million','output_micro_usd_per_million','image_micro_usd_per_thousand','created_at','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.model_prices') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','text','bigint','bigint','bigint','bigint','timestamp with time zone','timestamp with time zone'] OR
      EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.model_prices')
        AND attnum > 0 AND NOT attisdropped AND NOT attnotnull) OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.model_prices'))
        IS DISTINCT FROM ARRAY[
          'model_prices_model_check=CHECK ((model ~ ''^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$''::text))',
          'model_prices_pkey=PRIMARY KEY (id)',
          'model_prices_provider_id_providers_id_fk=FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE',
          'model_prices_rates_check=CHECK ((((input_micro_usd_per_million >= 0) AND (input_micro_usd_per_million <= 1000000000)) AND ((cached_micro_usd_per_million >= 0) AND (cached_micro_usd_per_million <= 1000000000)) AND ((output_micro_usd_per_million >= 0) AND (output_micro_usd_per_million <= 1000000000)) AND ((image_micro_usd_per_thousand >= 0) AND (image_micro_usd_per_thousand <= 1000000000))))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.model_prices'))
        IS DISTINCT FROM ARRAY[5,6,7,8,9,10] OR
      (SELECT count(*) FROM pg_attrdef WHERE adrelid = to_regclass('public.model_prices') AND adnum BETWEEN 5 AND 8 AND pg_get_expr(adbin, adrelid) = '0') <> 4 OR
      (SELECT count(*) FROM pg_attrdef WHERE adrelid = to_regclass('public.model_prices') AND adnum BETWEEN 9 AND 10 AND pg_get_expr(adbin, adrelid) = 'now()') <> 2 OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'model_prices')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX model_prices_owner_id_idx ON public.model_prices USING btree (owner_id)',
          'CREATE UNIQUE INDEX model_prices_owner_provider_model_idx ON public.model_prices USING btree (owner_id, provider_id, model)',
          'CREATE UNIQUE INDEX model_prices_pkey ON public.model_prices USING btree (id)',
          'CREATE INDEX model_prices_provider_id_idx ON public.model_prices USING btree (provider_id)']) THEN
    RAISE EXCEPTION 'unexpected model prices schema';
  END IF;
  IF to_regclass('public.checkpoints') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.checkpoints') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','run_id','idx','state_hash','manifest_hash','file_count','restorable_count','status','reason','created_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.checkpoints') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','integer','text','text','integer','integer','text','text','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.checkpoints') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,true,false,true,true,true,false,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.checkpoints'))
        IS DISTINCT FROM ARRAY[
          'checkpoints_pkey=PRIMARY KEY (id)',
          'checkpoints_run_id_runs_id_fk=FOREIGN KEY (run_id) REFERENCES runs(id)',
          'checkpoints_status_check=CHECK ((status = ANY (ARRAY[''complete''::text, ''partial''::text])))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.checkpoints'))
        IS DISTINCT FROM ARRAY[7,8,11] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.checkpoints') AND adnum IN (7,8) AND pg_get_expr(adbin, adrelid) <> '0') OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.checkpoints') AND adnum = 11 AND pg_get_expr(adbin, adrelid) <> 'now()') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'checkpoints')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX checkpoints_owner_id_idx ON public.checkpoints USING btree (owner_id)',
          'CREATE UNIQUE INDEX checkpoints_pkey ON public.checkpoints USING btree (id)',
          'CREATE UNIQUE INDEX checkpoints_run_idx_idx ON public.checkpoints USING btree (run_id, idx)']) THEN
    RAISE EXCEPTION 'unexpected checkpoints schema';
  END IF;
  IF to_regclass('public.teach_recordings') IS NULL AND to_regclass('public.cost_entries') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.cost_entries') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','run_id','agent_id','provider_id','call_index','model','tokens_in','tokens_out','tokens_cached','cost_micro_usd','outcome','idempotency_key','created_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.cost_entries') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','uuid','uuid','integer','text','integer','integer','integer','bigint','text','text','timestamp with time zone'] OR
      EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.cost_entries')
        AND attnum > 0 AND NOT attisdropped AND NOT attnotnull) OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.cost_entries'))
        IS DISTINCT FROM ARRAY[
          'cost_entries_call_index_check=CHECK ((call_index > 0))',
          'cost_entries_cost_check=CHECK ((cost_micro_usd >= 0))',
          'cost_entries_idempotency_check=CHECK ((idempotency_key = (((''cost:''::text || (run_id)::text) || '':''::text) || (call_index)::text)))',
          'cost_entries_outcome_check=CHECK ((outcome ~ ''^[a-z_]{1,64}$''::text))',
          'cost_entries_pkey=PRIMARY KEY (id)',
          'cost_entries_run_id_runs_id_fk=FOREIGN KEY (run_id) REFERENCES runs(id)',
          'cost_entries_tokens_check=CHECK (((tokens_in >= 0) AND (tokens_out >= 0) AND (tokens_cached >= 0) AND (tokens_cached <= tokens_in)))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.cost_entries'))
        IS DISTINCT FROM ARRAY[14] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.cost_entries') AND pg_get_expr(adbin, adrelid) <> 'now()') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'cost_entries')
        IS DISTINCT FROM ARRAY[
          'CREATE UNIQUE INDEX cost_entries_idempotency_key_idx ON public.cost_entries USING btree (idempotency_key)',
          'CREATE INDEX cost_entries_owner_id_idx ON public.cost_entries USING btree (owner_id)',
          'CREATE UNIQUE INDEX cost_entries_pkey ON public.cost_entries USING btree (id)',
          'CREATE UNIQUE INDEX cost_entries_run_call_idx ON public.cost_entries USING btree (run_id, call_index)',
          'CREATE INDEX cost_entries_run_id_idx ON public.cost_entries USING btree (run_id)']) THEN
    RAISE EXCEPTION 'unexpected cost entries schema';
  END IF;

  -- Exact post-0013 catalog contracts. Pre-0013 contracts above remain unchanged.
  IF to_regclass('public.teach_recordings') IS NOT NULL AND (
      to_regclass('public.model_prices') IS NULL OR
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.model_prices') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['id','owner_id','provider_id','model','input_micro_usd_per_million','cached_micro_usd_per_million','output_micro_usd_per_million','image_micro_usd_per_thousand','created_at','updated_at','audio_micro_usd_per_hour'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.model_prices') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['uuid','uuid','uuid','text','bigint','bigint','bigint','bigint','timestamp with time zone','timestamp with time zone','bigint'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.model_prices') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY[true,true,true,true,true,true,true,true,true,true,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.model_prices')) IS DISTINCT FROM ARRAY['model_prices_model_check=CHECK ((model ~ ''^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$''::text))','model_prices_pkey=PRIMARY KEY (id)','model_prices_provider_id_providers_id_fk=FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE','model_prices_rates_check=CHECK ((((input_micro_usd_per_million >= 0) AND (input_micro_usd_per_million <= 1000000000)) AND ((cached_micro_usd_per_million >= 0) AND (cached_micro_usd_per_million <= 1000000000)) AND ((output_micro_usd_per_million >= 0) AND (output_micro_usd_per_million <= 1000000000)) AND ((image_micro_usd_per_thousand >= 0) AND (image_micro_usd_per_thousand <= 1000000000)) AND ((audio_micro_usd_per_hour >= 0) AND (audio_micro_usd_per_hour <= 1000000000))))'] OR
      (SELECT array_agg(adnum::integer::text || '=' || pg_get_expr(adbin,adrelid) ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.model_prices')) IS DISTINCT FROM ARRAY['5=0','6=0','7=0','8=0','9=now()','10=now()','11=0'] OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'model_prices') IS DISTINCT FROM ARRAY['CREATE INDEX model_prices_owner_id_idx ON public.model_prices USING btree (owner_id)','CREATE UNIQUE INDEX model_prices_owner_provider_model_idx ON public.model_prices USING btree (owner_id, provider_id, model)','CREATE UNIQUE INDEX model_prices_pkey ON public.model_prices USING btree (id)','CREATE INDEX model_prices_provider_id_idx ON public.model_prices USING btree (provider_id)']) THEN
    RAISE EXCEPTION 'unexpected model_prices post-0013 schema';
  END IF;
  -- 0013-0033 shape: before 0034 adds background_job_id. Kept so an existing
  -- install can be provisioned before its next migrate (history check pins which applies).
  IF to_regclass('public.teach_recordings') IS NOT NULL AND to_regclass('public.cost_entries') IS NOT NULL AND
      NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.cost_entries') AND attname = 'background_job_id' AND NOT attisdropped) AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.cost_entries') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['id','owner_id','run_id','agent_id','provider_id','call_index','model','tokens_in','tokens_out','tokens_cached','cost_micro_usd','outcome','idempotency_key','created_at','capture_id','audio_duration_ms'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.cost_entries') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['uuid','uuid','uuid','uuid','uuid','integer','text','integer','integer','integer','bigint','text','text','timestamp with time zone','uuid','integer'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.cost_entries') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY[true,true,false,true,true,true,true,true,true,true,true,true,true,true,false,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.cost_entries')) IS DISTINCT FROM ARRAY['cost_entries_audio_duration_check=CHECK (((audio_duration_ms >= 0) AND (audio_duration_ms <= 120000)))','cost_entries_call_index_check=CHECK ((call_index > 0))','cost_entries_capture_id_teach_recordings_id_fk=FOREIGN KEY (capture_id) REFERENCES teach_recordings(id)','cost_entries_cost_check=CHECK ((cost_micro_usd >= 0))','cost_entries_idempotency_check=CHECK ((((run_id IS NOT NULL) AND (idempotency_key = (((''cost:''::text || (run_id)::text) || '':''::text) || (call_index)::text))) OR ((capture_id IS NOT NULL) AND ((idempotency_key = (((''teach:''::text || (capture_id)::text) || '':asr:''::text) || ((call_index - 1))::text)) OR (idempotency_key = (((''teach:''::text || (capture_id)::text) || '':skill:''::text) || (call_index)::text))))))','cost_entries_outcome_check=CHECK ((outcome ~ ''^[a-z_]{1,64}$''::text))','cost_entries_pkey=PRIMARY KEY (id)','cost_entries_run_id_runs_id_fk=FOREIGN KEY (run_id) REFERENCES runs(id)','cost_entries_source_check=CHECK (((((run_id IS NOT NULL))::integer + ((capture_id IS NOT NULL))::integer) = 1))','cost_entries_tokens_check=CHECK (((tokens_in >= 0) AND (tokens_out >= 0) AND (tokens_cached >= 0) AND (tokens_cached <= tokens_in)))'] OR
      (SELECT array_agg(adnum::integer::text || '=' || pg_get_expr(adbin,adrelid) ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.cost_entries')) IS DISTINCT FROM ARRAY['14=now()','16=0'] OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'cost_entries') IS DISTINCT FROM ARRAY['CREATE UNIQUE INDEX cost_entries_capture_call_idx ON public.cost_entries USING btree (capture_id, call_index)','CREATE UNIQUE INDEX cost_entries_idempotency_key_idx ON public.cost_entries USING btree (idempotency_key)','CREATE INDEX cost_entries_owner_id_idx ON public.cost_entries USING btree (owner_id)','CREATE UNIQUE INDEX cost_entries_pkey ON public.cost_entries USING btree (id)','CREATE UNIQUE INDEX cost_entries_run_call_idx ON public.cost_entries USING btree (run_id, call_index)','CREATE INDEX cost_entries_run_id_idx ON public.cost_entries USING btree (run_id)']) THEN
    RAISE EXCEPTION 'unexpected cost_entries post-0013 schema';
  END IF;
  -- 0034+ shape: background maintenance jobs are a third cost source.
  IF to_regclass('public.teach_recordings') IS NOT NULL AND (to_regclass('public.cost_entries') IS NULL OR
      EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.cost_entries') AND attname = 'background_job_id' AND NOT attisdropped)) AND (
      to_regclass('public.cost_entries') IS NULL OR
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.cost_entries') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['id','owner_id','run_id','agent_id','provider_id','call_index','model','tokens_in','tokens_out','tokens_cached','cost_micro_usd','outcome','idempotency_key','created_at','capture_id','audio_duration_ms','background_job_id'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.cost_entries') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['uuid','uuid','uuid','uuid','uuid','integer','text','integer','integer','integer','bigint','text','text','timestamp with time zone','uuid','integer','uuid'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.cost_entries') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY[true,true,false,true,true,true,true,true,true,true,true,true,true,true,false,true,false] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.cost_entries')) IS DISTINCT FROM ARRAY['cost_entries_audio_duration_check=CHECK (((audio_duration_ms >= 0) AND (audio_duration_ms <= 120000)))','cost_entries_call_index_check=CHECK ((call_index > 0))','cost_entries_capture_id_teach_recordings_id_fk=FOREIGN KEY (capture_id) REFERENCES teach_recordings(id)','cost_entries_cost_check=CHECK ((cost_micro_usd >= 0))','cost_entries_idempotency_check=CHECK ((((run_id IS NOT NULL) AND (idempotency_key = (((''cost:''::text || (run_id)::text) || '':''::text) || (call_index)::text))) OR ((capture_id IS NOT NULL) AND ((idempotency_key = (((''teach:''::text || (capture_id)::text) || '':asr:''::text) || ((call_index - 1))::text)) OR (idempotency_key = (((''teach:''::text || (capture_id)::text) || '':skill:''::text) || (call_index)::text)))) OR ((background_job_id IS NOT NULL) AND (idempotency_key = (((''cost:job:''::text || (background_job_id)::text) || '':''::text) || (call_index)::text)))))','cost_entries_outcome_check=CHECK ((outcome ~ ''^[a-z_]{1,64}$''::text))','cost_entries_pkey=PRIMARY KEY (id)','cost_entries_run_id_runs_id_fk=FOREIGN KEY (run_id) REFERENCES runs(id)','cost_entries_source_check=CHECK ((((((run_id IS NOT NULL))::integer + ((capture_id IS NOT NULL))::integer) + ((background_job_id IS NOT NULL))::integer) = 1))','cost_entries_tokens_check=CHECK (((tokens_in >= 0) AND (tokens_out >= 0) AND (tokens_cached >= 0) AND (tokens_cached <= tokens_in)))'] OR
      (SELECT array_agg(adnum::integer::text || '=' || pg_get_expr(adbin,adrelid) ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.cost_entries')) IS DISTINCT FROM ARRAY['14=now()','16=0'] OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'cost_entries') IS DISTINCT FROM ARRAY['CREATE UNIQUE INDEX cost_entries_capture_call_idx ON public.cost_entries USING btree (capture_id, call_index)','CREATE UNIQUE INDEX cost_entries_idempotency_key_idx ON public.cost_entries USING btree (idempotency_key)','CREATE UNIQUE INDEX cost_entries_job_call_idx ON public.cost_entries USING btree (background_job_id, call_index)','CREATE INDEX cost_entries_owner_id_idx ON public.cost_entries USING btree (owner_id)','CREATE UNIQUE INDEX cost_entries_pkey ON public.cost_entries USING btree (id)','CREATE UNIQUE INDEX cost_entries_run_call_idx ON public.cost_entries USING btree (run_id, call_index)','CREATE INDEX cost_entries_run_id_idx ON public.cost_entries USING btree (run_id)']) THEN
    RAISE EXCEPTION 'unexpected cost_entries post-0013 schema';
  END IF;
  IF to_regclass('public.teach_recordings') IS NOT NULL AND (
      to_regclass('public.teach_recordings') IS NULL OR
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.teach_recordings') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['id','owner_id','agent_id','generation','state','reason','timezone','narration','narration_status','narration_segments','manifest','active_ms','event_count','created_at','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.teach_recordings') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['uuid','uuid','uuid','uuid','text','text','text','boolean','text','jsonb','jsonb','integer','integer','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.teach_recordings') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY[true,true,true,true,true,false,true,true,true,true,false,true,true,true,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.teach_recordings')) IS DISTINCT FROM ARRAY['teach_recordings_bounds_check=CHECK ((((active_ms >= 0) AND (active_ms <= 120000)) AND ((event_count >= 0) AND (event_count <= 300))))','teach_recordings_narration_status_check=CHECK ((narration_status = ANY (ARRAY[''off''::text, ''pending''::text, ''working''::text, ''complete''::text, ''error''::text, ''uncertain''::text])))','teach_recordings_pkey=PRIMARY KEY (id)','teach_recordings_state_check=CHECK ((state = ANY (ARRAY[''recording''::text, ''paused''::text, ''finalizing''::text, ''complete''::text, ''aborted''::text, ''failed''::text, ''discarded''::text])))'] OR
      (SELECT array_agg(adnum::integer::text || '=' || pg_get_expr(adbin,adrelid) ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.teach_recordings')) IS DISTINCT FROM ARRAY['8=false','9=''off''::text','10=''[]''::jsonb','12=0','13=0','14=now()','15=now()'] OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'teach_recordings') IS DISTINCT FROM ARRAY['CREATE UNIQUE INDEX teach_recordings_active_agent_idx ON public.teach_recordings USING btree (owner_id, agent_id) WHERE (state = ANY (ARRAY[''recording''::text, ''paused''::text, ''finalizing''::text]))','CREATE INDEX teach_recordings_agent_id_idx ON public.teach_recordings USING btree (agent_id)','CREATE INDEX teach_recordings_owner_id_idx ON public.teach_recordings USING btree (owner_id)','CREATE UNIQUE INDEX teach_recordings_pkey ON public.teach_recordings USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected teach_recordings post-0013 schema';
  END IF;
  IF to_regclass('public.teach_recordings') IS NOT NULL AND (
      to_regclass('public.messages') IS NULL OR
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.messages') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['id','owner_id','session_id','role','card_type','content','source_tag','run_id','created_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.messages') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY['uuid','uuid','uuid','text','text','jsonb','text','uuid','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute WHERE attrelid = to_regclass('public.messages') AND attnum > 0 AND NOT attisdropped) IS DISTINCT FROM ARRAY[true,true,true,true,true,true,true,false,true] OR
      ((SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.messages')) IS DISTINCT FROM ARRAY['messages_card_type_check=CHECK ((card_type = ANY (ARRAY[''message''::text, ''clarification''::text, ''tool_connection''::text, ''routine''::text, ''file''::text, ''budget_warning''::text, ''budget_paused''::text, ''teach_paused''::text])))','messages_pkey=PRIMARY KEY (id)','messages_role_check=CHECK ((role = ANY (ARRAY[''user''::text, ''agent''::text, ''system''::text])))','messages_session_id_chat_sessions_id_fk=FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE','messages_source_tag_check=CHECK ((source_tag = ANY (ARRAY[''user''::text, ''agent''::text, ''tool''::text, ''system''::text])))'] AND
       (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.messages')) IS DISTINCT FROM ARRAY['messages_card_type_check=CHECK ((card_type = ANY (ARRAY[''message''::text, ''clarification''::text, ''tool_connection''::text, ''routine''::text, ''file''::text, ''budget_warning''::text, ''budget_paused''::text, ''teach_paused''::text, ''skill_update''::text, ''approval''::text, ''memory_change''::text])))','messages_pkey=PRIMARY KEY (id)','messages_role_check=CHECK ((role = ANY (ARRAY[''user''::text, ''agent''::text, ''system''::text])))','messages_session_id_chat_sessions_id_fk=FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE','messages_source_tag_check=CHECK ((source_tag = ANY (ARRAY[''user''::text, ''agent''::text, ''tool''::text, ''system''::text])))'] AND
       (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.messages')) IS DISTINCT FROM ARRAY['messages_card_type_check=CHECK ((card_type = ANY (ARRAY[''message''::text, ''clarification''::text, ''tool_connection''::text, ''routine''::text, ''file''::text, ''budget_warning''::text, ''budget_paused''::text, ''teach_paused''::text, ''skill_update''::text, ''approval''::text, ''memory_change''::text, ''memory_saved''::text, ''memory_tidied''::text, ''crew_report''::text])))','messages_pkey=PRIMARY KEY (id)','messages_role_check=CHECK ((role = ANY (ARRAY[''user''::text, ''agent''::text, ''system''::text])))','messages_session_id_chat_sessions_id_fk=FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE','messages_source_tag_check=CHECK ((source_tag = ANY (ARRAY[''user''::text, ''agent''::text, ''tool''::text, ''system''::text])))'] AND
       (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.messages')) IS DISTINCT FROM ARRAY['messages_card_type_check=CHECK ((card_type = ANY (ARRAY[''message''::text, ''clarification''::text, ''tool_connection''::text, ''routine''::text, ''file''::text, ''budget_warning''::text, ''budget_paused''::text, ''teach_paused''::text, ''skill_update''::text, ''approval''::text, ''memory_change''::text, ''memory_saved''::text, ''memory_tidied''::text])))','messages_pkey=PRIMARY KEY (id)','messages_role_check=CHECK ((role = ANY (ARRAY[''user''::text, ''agent''::text, ''system''::text])))','messages_session_id_chat_sessions_id_fk=FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE','messages_source_tag_check=CHECK ((source_tag = ANY (ARRAY[''user''::text, ''agent''::text, ''tool''::text, ''system''::text])))']) OR
      (SELECT array_agg(adnum::integer::text || '=' || pg_get_expr(adbin,adrelid) ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.messages')) IS DISTINCT FROM ARRAY['9=now()'] OR
      ((SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'messages') IS DISTINCT FROM ARRAY['CREATE INDEX messages_owner_id_idx ON public.messages USING btree (owner_id)','CREATE UNIQUE INDEX messages_pkey ON public.messages USING btree (id)','CREATE INDEX messages_run_id_idx ON public.messages USING btree (run_id)','CREATE INDEX messages_session_created_idx ON public.messages USING btree (session_id, created_at, id)'] AND
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'messages') IS DISTINCT FROM ARRAY['CREATE INDEX messages_owner_id_idx ON public.messages USING btree (owner_id)','CREATE UNIQUE INDEX messages_pkey ON public.messages USING btree (id)','CREATE INDEX messages_run_id_idx ON public.messages USING btree (run_id)','CREATE INDEX messages_search_idx ON public.messages USING gin (to_tsvector(''simple''::regconfig, ((COALESCE((content ->> ''text''::text), ''''::text) || '' ''::text) || COALESCE((content ->> ''question''::text), ''''::text))))','CREATE INDEX messages_session_created_idx ON public.messages USING btree (session_id, created_at, id)'])) THEN
    RAISE EXCEPTION 'unexpected messages post-0013 schema';
  END IF;
  IF to_regclass('public.owner') IS NOT NULL AND (
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.owner') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.owner') AND attname = 'crew_stopped_at' AND NOT attisdropped)
          THEN ARRAY[true,true,true,true,true,true,false]
          ELSE ARRAY[true,true,true,true,true,true] END) OR
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
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'avatar_variant' AND NOT attisdropped)
          THEN ARRAY['id','owner_id','name','role','soul_md','status','daily_budget_cents','monthly_budget_cents','created_at','updated_at','attention_reason','astra_mode','avatar_variant']
          WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'astra_mode' AND NOT attisdropped)
          THEN ARRAY['id','owner_id','name','role','soul_md','status','daily_budget_cents','monthly_budget_cents','created_at','updated_at','attention_reason','astra_mode']
          ELSE ARRAY['id','owner_id','name','role','soul_md','status','daily_budget_cents','monthly_budget_cents','created_at','updated_at','attention_reason'] END) OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.agents') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'avatar_variant' AND NOT attisdropped)
          THEN ARRAY['uuid','uuid','text','text','text','text','integer','integer','timestamp with time zone','timestamp with time zone','text','boolean','integer']
          WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'astra_mode' AND NOT attisdropped)
          THEN ARRAY['uuid','uuid','text','text','text','text','integer','integer','timestamp with time zone','timestamp with time zone','text','boolean']
          ELSE ARRAY['uuid','uuid','text','text','text','text','integer','integer','timestamp with time zone','timestamp with time zone','text'] END) OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.agents') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'avatar_variant' AND NOT attisdropped)
          THEN ARRAY[true,true,true,true,true,true,true,true,true,true,false,true,true]
          WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'astra_mode' AND NOT attisdropped)
          THEN ARRAY[true,true,true,true,true,true,true,true,true,true,false,true]
          ELSE ARRAY[true,true,true,true,true,true,true,true,true,true,false] END) OR
      ((SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.agents'))
        IS DISTINCT FROM array_remove(ARRAY[
          'agents_attention_reason_check=CHECK (((attention_reason IS NULL) OR (attention_reason = ANY (ARRAY[''budget_warning''::text, ''budget_paused''::text]))))',
          CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'avatar_variant' AND NOT attisdropped) THEN 'agents_avatar_variant_check=CHECK (((avatar_variant >= 0) AND (avatar_variant <= 11)))' END,
          'agents_daily_budget_check=CHECK (((daily_budget_cents >= 1) AND (daily_budget_cents <= 100000000)))',
          'agents_monthly_budget_check=CHECK (((monthly_budget_cents >= 1) AND (monthly_budget_cents <= 100000000)))',
          'agents_pkey=PRIMARY KEY (id)',
          'agents_status_check=CHECK ((status = ANY (ARRAY[''active''::text, ''paused''::text])))'], NULL) AND
       (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.agents'))
        IS DISTINCT FROM array_remove(ARRAY[
          'agents_attention_reason_check=CHECK (((attention_reason IS NULL) OR (attention_reason = ANY (ARRAY[''budget_warning''::text, ''budget_paused''::text, ''security_stop''::text, ''approval_pending''::text]))))',
          CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'avatar_variant' AND NOT attisdropped) THEN 'agents_avatar_variant_check=CHECK (((avatar_variant >= 0) AND (avatar_variant <= 11)))' END,
          'agents_daily_budget_check=CHECK (((daily_budget_cents >= 1) AND (daily_budget_cents <= 100000000)))',
          'agents_monthly_budget_check=CHECK (((monthly_budget_cents >= 1) AND (monthly_budget_cents <= 100000000)))',
          'agents_pkey=PRIMARY KEY (id)',
          'agents_status_check=CHECK ((status = ANY (ARRAY[''active''::text, ''paused''::text])))'], NULL)) OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.agents'))
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'avatar_variant' AND NOT attisdropped)
          THEN ARRAY[6,9,10,12,13]
          WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'astra_mode' AND NOT attisdropped)
          THEN ARRAY[6,9,10,12] ELSE ARRAY[6,9,10] END) OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.agents') AND pg_get_expr(adbin, adrelid) <> 'now()' AND adnum <> 6 AND adnum <> 12 AND adnum <> 13) OR
      (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = to_regclass('public.agents') AND adnum = 6)
        IS DISTINCT FROM '''paused''::text' OR
      (EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'astra_mode' AND NOT attisdropped)
        AND (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = to_regclass('public.agents') AND adnum = 12)
          IS DISTINCT FROM 'false') OR
      (EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'avatar_variant' AND NOT attisdropped)
        AND (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = to_regclass('public.agents') AND adnum = 13)
          IS DISTINCT FROM '0') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'agents')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX agents_owner_id_idx ON public.agents USING btree (owner_id)',
          'CREATE UNIQUE INDEX agents_pkey ON public.agents USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected agents schema';
  END IF;
  IF to_regclass('public.agent_canaries') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.agent_canaries') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['agent_id','owner_id','encrypted_canary','canary_sha256','created_at','planted_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.agent_canaries') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','text','text','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.agent_canaries') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,true,false] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.agent_canaries'))
        IS DISTINCT FROM ARRAY[
          'agent_canaries_agent_id_agents_id_fk=FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE',
          'agent_canaries_pkey=PRIMARY KEY (agent_id)'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.agent_canaries'))
        IS DISTINCT FROM ARRAY[5] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.agent_canaries') AND pg_get_expr(adbin, adrelid) <> 'now()') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'agent_canaries')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX agent_canaries_owner_id_idx ON public.agent_canaries USING btree (owner_id)',
          'CREATE UNIQUE INDEX agent_canaries_pkey ON public.agent_canaries USING btree (agent_id)',
          'CREATE UNIQUE INDEX agent_canaries_sha256_idx ON public.agent_canaries USING btree (canary_sha256)']) THEN
    RAISE EXCEPTION 'unexpected agent canaries schema';
  END IF;
  IF to_regclass('public.security_events') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.security_events') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','agent_id','kind','source','run_id','source_ref','created_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.security_events') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','text','text','uuid','text','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.security_events') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,true,false,false,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.security_events'))
        IS DISTINCT FROM ARRAY[
          'security_events_kind_check=CHECK ((kind = ANY (ARRAY[''canary_leak''::text, ''scope_blocked''::text])))',
          'security_events_pkey=PRIMARY KEY (id)',
          'security_events_source_check=CHECK ((source = ANY (ARRAY[''typed_text''::text, ''proxy_host''::text, ''proxy_request''::text, ''scope_host''::text, ''scope_recipient''::text, ''scope_page''::text])))',
          'security_events_source_ref_unique=UNIQUE (source_ref)'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.security_events'))
        IS DISTINCT FROM ARRAY[8] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.security_events') AND pg_get_expr(adbin, adrelid) <> 'now()') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'security_events')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX security_events_owner_created_idx ON public.security_events USING btree (owner_id, created_at DESC NULLS LAST)',
          'CREATE UNIQUE INDEX security_events_pkey ON public.security_events USING btree (id)',
          'CREATE UNIQUE INDEX security_events_source_ref_unique ON public.security_events USING btree (source_ref)']) THEN
    RAISE EXCEPTION 'unexpected security events schema';
  END IF;
  IF to_regclass('public.approvals') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.approvals') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','agent_id','run_id','action_class','site','control_name','state','decided_at','created_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.approvals') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','uuid','text','text','text','text','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.approvals') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,false,true,true,true,true,false,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.approvals'))
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'astra_mode' AND NOT attisdropped)
          THEN ARRAY[
          'approvals_action_class_check=CHECK ((action_class = ANY (ARRAY[''download''::text, ''send''::text, ''post''::text, ''delete''::text, ''purchase''::text, ''submit''::text])))',
          'approvals_control_name_check=CHECK (((char_length(control_name) >= 1) AND (char_length(control_name) <= 120)))',
          'approvals_pkey=PRIMARY KEY (id)',
          'approvals_site_check=CHECK ((char_length(site) <= 255))',
          'approvals_state_check=CHECK ((state = ANY (ARRAY[''pending''::text, ''allowed_once''::text, ''always_allowed''::text, ''denied''::text, ''expired''::text, ''stale''::text, ''auto_allowed''::text])))']
          ELSE ARRAY[
          'approvals_action_class_check=CHECK ((action_class = ANY (ARRAY[''download''::text, ''send''::text, ''post''::text, ''delete''::text, ''purchase''::text, ''submit''::text])))',
          'approvals_control_name_check=CHECK (((char_length(control_name) >= 1) AND (char_length(control_name) <= 120)))',
          'approvals_pkey=PRIMARY KEY (id)',
          'approvals_site_check=CHECK ((char_length(site) <= 255))',
          'approvals_state_check=CHECK ((state = ANY (ARRAY[''pending''::text, ''allowed_once''::text, ''always_allowed''::text, ''denied''::text, ''expired''::text, ''stale''::text])))'] END) OR
      (SELECT array_agg(adnum::integer::text || '=' || pg_get_expr(adbin,adrelid) ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.approvals'))
        IS DISTINCT FROM ARRAY['6=''''::text','8=''pending''::text','10=now()'] OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'approvals')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX approvals_owner_id_idx ON public.approvals USING btree (owner_id)',
          'CREATE UNIQUE INDEX approvals_pkey ON public.approvals USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected approvals schema';
  END IF;
  IF to_regclass('public.permissions') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.permissions') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','agent_id','site','action_class','max_per_day','created_at','revoked_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.permissions') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','text','text','integer','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.permissions') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,true,true,true,false] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.permissions'))
        IS DISTINCT FROM ARRAY[
          'permissions_action_class_check=CHECK ((action_class = ANY (ARRAY[''download''::text, ''send''::text, ''post''::text, ''delete''::text, ''purchase''::text, ''submit''::text])))',
          'permissions_agent_id_agents_id_fk=FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE',
          'permissions_max_per_day_check=CHECK (((max_per_day >= 1) AND (max_per_day <= 1000)))',
          'permissions_pkey=PRIMARY KEY (id)',
          'permissions_site_check=CHECK (((char_length(site) >= 1) AND (char_length(site) <= 255)))'] OR
      (SELECT array_agg(adnum::integer::text || '=' || pg_get_expr(adbin,adrelid) ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.permissions'))
        IS DISTINCT FROM ARRAY['6=20','7=now()'] OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'permissions')
        IS DISTINCT FROM ARRAY[
          'CREATE UNIQUE INDEX permissions_active_idx ON public.permissions USING btree (agent_id, site, action_class) WHERE (revoked_at IS NULL)',
          'CREATE INDEX permissions_owner_id_idx ON public.permissions USING btree (owner_id)',
          'CREATE UNIQUE INDEX permissions_pkey ON public.permissions USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected permissions schema';
  END IF;
  IF to_regclass('public.permission_uses') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.permission_uses') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','permission_id','run_id','used_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.permission_uses') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','uuid','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.permission_uses') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,false,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.permission_uses'))
        IS DISTINCT FROM ARRAY[
          'permission_uses_permission_id_permissions_id_fk=FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE',
          'permission_uses_pkey=PRIMARY KEY (id)'] OR
      (SELECT array_agg(adnum::integer::text || '=' || pg_get_expr(adbin,adrelid) ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.permission_uses'))
        IS DISTINCT FROM ARRAY['5=now()'] OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'permission_uses')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX permission_uses_permission_used_idx ON public.permission_uses USING btree (permission_id, used_at)',
          'CREATE UNIQUE INDEX permission_uses_pkey ON public.permission_uses USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected permission uses schema';
  END IF;
  IF to_regclass('public.connections') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.connections') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','agent_id','preset','label','bindings','encrypted_token','token_hint','created_at','updated_at','encrypted_refresh_token','token_expires_at','refresh_expires_at','source','status'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.connections') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','text','text','jsonb','text','text','timestamp with time zone','timestamp with time zone','text','timestamp with time zone','timestamp with time zone','text','text'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.connections') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,true,true,true,true,true,true,false,false,false,true,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.connections'))
        IS DISTINCT FROM ARRAY[
          'connections_agent_id_agents_id_fk=FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE',
          'connections_bindings_check=CHECK (((jsonb_typeof(bindings) = ''array''::text) AND ((jsonb_array_length(bindings) >= 1) AND (jsonb_array_length(bindings) <= 4))))',
          'connections_label_check=CHECK (((char_length(label) >= 1) AND (char_length(label) <= 60)))',
          'connections_pkey=PRIMARY KEY (id)',
          'connections_preset_check=CHECK ((preset = ANY (ARRAY[''github''::text, ''custom''::text])))',
          'connections_source_check=CHECK ((source = ANY (ARRAY[''pasted''::text, ''github_app''::text])))',
          'connections_status_check=CHECK ((status = ANY (ARRAY[''active''::text, ''expired''::text])))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.connections'))
        IS DISTINCT FROM ARRAY[9,10,14,15] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.connections')
        AND ((adnum = 14 AND pg_get_expr(adbin, adrelid) <> '''pasted''::text')
          OR (adnum = 15 AND pg_get_expr(adbin, adrelid) <> '''active''::text')
          OR (adnum IN (9,10) AND pg_get_expr(adbin, adrelid) <> 'now()'))) OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'connections')
        IS DISTINCT FROM ARRAY[
          'CREATE UNIQUE INDEX connections_agent_label_idx ON public.connections USING btree (agent_id, label)',
          'CREATE INDEX connections_owner_id_idx ON public.connections USING btree (owner_id)',
          'CREATE UNIQUE INDEX connections_pkey ON public.connections USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected connections schema';
  END IF;
  IF to_regclass('public.mcp_servers') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.mcp_servers') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','agent_id','key','preset','url','connection_id','server_name','server_version','protocol_version','tools_hash','tools','status','pinned_at','created_at','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.mcp_servers') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','text','text','text','uuid','text','text','text','text','jsonb','text','timestamp with time zone','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.mcp_servers') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,true,true,true,true,true,true,true,true,true,true,true,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.mcp_servers'))
        IS DISTINCT FROM ARRAY[
          'mcp_servers_agent_id_agents_id_fk=FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE',
          'mcp_servers_connection_id_connections_id_fk=FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE RESTRICT',
          'mcp_servers_key_check=CHECK ((key ~ ''^[a-z0-9-]{1,32}$''::text))',
          'mcp_servers_pkey=PRIMARY KEY (id)',
          'mcp_servers_preset_check=CHECK ((preset = ANY (ARRAY[''github''::text, ''custom''::text])))',
          'mcp_servers_status_check=CHECK ((status = ANY (ARRAY[''pinned''::text, ''changed''::text, ''disabled''::text])))',
          'mcp_servers_tools_check=CHECK (((jsonb_typeof(tools) = ''array''::text) AND (pg_column_size(tools) <= 262144)))',
          'mcp_servers_tools_hash_check=CHECK ((tools_hash ~ ''^[0-9a-f]{64}$''::text))',
          'mcp_servers_url_check=CHECK (((url ~ ''^https://[^[:space:]]+$''::text) AND (char_length(url) <= 2048)))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.mcp_servers'))
        IS DISTINCT FROM ARRAY[13,14,15,16] OR
      EXISTS (SELECT FROM pg_attrdef d WHERE d.adrelid = to_regclass('public.mcp_servers')
        AND ((d.adnum = 13 AND pg_get_expr(d.adbin, d.adrelid) <> '''pinned''::text')
          OR (d.adnum IN (14,15,16) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()'))) OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'mcp_servers')
        IS DISTINCT FROM ARRAY[
          'CREATE UNIQUE INDEX mcp_servers_agent_key_idx ON public.mcp_servers USING btree (agent_id, key)',
          'CREATE INDEX mcp_servers_owner_id_idx ON public.mcp_servers USING btree (owner_id)',
          'CREATE UNIQUE INDEX mcp_servers_pkey ON public.mcp_servers USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected mcp servers schema';
  END IF;
  IF to_regclass('public.composio_keys') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.composio_keys') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','encrypted_key','key_hint','injection_check','created_at','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.composio_keys') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','text','text','boolean','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.composio_keys') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,true,true,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.composio_keys'))
        IS DISTINCT FROM ARRAY[
          'composio_keys_hint_check=CHECK (((char_length(key_hint) >= 1) AND (char_length(key_hint) <= 32)))',
          'composio_keys_pkey=PRIMARY KEY (id)'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.composio_keys'))
        IS DISTINCT FROM ARRAY[5,6,7] OR
      EXISTS (SELECT FROM pg_attrdef d WHERE d.adrelid = to_regclass('public.composio_keys')
        AND ((d.adnum = 5 AND pg_get_expr(d.adbin, d.adrelid) <> 'false')
          OR (d.adnum IN (6,7) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()'))) OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'composio_keys')
        IS DISTINCT FROM ARRAY[
          'CREATE UNIQUE INDEX composio_keys_owner_idx ON public.composio_keys USING btree (owner_id)',
          'CREATE UNIQUE INDEX composio_keys_pkey ON public.composio_keys USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected composio keys schema';
  END IF;
  IF to_regclass('public.composio_accounts') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.composio_accounts') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','agent_id','toolkit','connected_account_id','status','tools_hash','tools','pinned_at','created_at','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.composio_accounts') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','text','text','text','text','jsonb','timestamp with time zone','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.composio_accounts') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,false,true,false,false,false,true,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.composio_accounts'))
        IS DISTINCT FROM ARRAY[
          'composio_accounts_agent_id_agents_id_fk=FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE',
          'composio_accounts_pkey=PRIMARY KEY (id)',
          'composio_accounts_status_check=CHECK ((status = ANY (ARRAY[''pending''::text, ''active''::text, ''failed''::text, ''revoked''::text, ''changed''::text])))',
          'composio_accounts_toolkit_check=CHECK ((toolkit ~ ''^[a-z0-9_]{2,40}$''::text))',
          'composio_accounts_tools_check=CHECK (((tools IS NULL) OR ((jsonb_typeof(tools) = ''array''::text) AND (pg_column_size(tools) <= 262144))))',
          'composio_accounts_tools_hash_check=CHECK (((tools_hash IS NULL) OR (tools_hash ~ ''^[0-9a-f]{64}$''::text)))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.composio_accounts'))
        IS DISTINCT FROM ARRAY[6,10,11] OR
      EXISTS (SELECT FROM pg_attrdef d WHERE d.adrelid = to_regclass('public.composio_accounts')
        AND ((d.adnum = 6 AND pg_get_expr(d.adbin, d.adrelid) <> '''pending''::text')
          OR (d.adnum IN (10,11) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()'))) OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'composio_accounts')
        IS DISTINCT FROM ARRAY[
          'CREATE UNIQUE INDEX composio_accounts_agent_toolkit_idx ON public.composio_accounts USING btree (agent_id, toolkit)',
          'CREATE INDEX composio_accounts_owner_agent_idx ON public.composio_accounts USING btree (owner_id, agent_id)',
          'CREATE INDEX composio_accounts_owner_id_idx ON public.composio_accounts USING btree (owner_id)',
          'CREATE UNIQUE INDEX composio_accounts_pkey ON public.composio_accounts USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected composio accounts schema';
  END IF;
  IF to_regclass('public.starter_crew_setups') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.starter_crew_setups') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','state','created_at','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.starter_crew_setups') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','text','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.starter_crew_setups') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.starter_crew_setups'))
        IS DISTINCT FROM ARRAY[
          'starter_crew_setups_pkey=PRIMARY KEY (id)',
          'starter_crew_setups_state_check=CHECK ((state = ANY (ARRAY[''creating''::text, ''partial''::text, ''complete''::text])))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.starter_crew_setups'))
        IS DISTINCT FROM ARRAY[3,4,5] OR
      EXISTS (SELECT FROM pg_attrdef d WHERE d.adrelid = to_regclass('public.starter_crew_setups')
        AND ((d.adnum = 3 AND pg_get_expr(d.adbin, d.adrelid) <> '''creating''::text')
          OR (d.adnum IN (4,5) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()'))) OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'starter_crew_setups')
        IS DISTINCT FROM ARRAY[
          'CREATE UNIQUE INDEX starter_crew_setups_owner_idx ON public.starter_crew_setups USING btree (owner_id)',
          'CREATE UNIQUE INDEX starter_crew_setups_pkey ON public.starter_crew_setups USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected starter crew setups schema';
  END IF;
  IF to_regclass('public.starter_crew_members') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.starter_crew_members') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','setup_id','template_id','agent_id','state','error_code','created_at','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.starter_crew_members') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','text','uuid','text','text','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.starter_crew_members') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,true,true,false,true,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.starter_crew_members'))
        IS DISTINCT FROM ARRAY[
          'starter_crew_members_error_check=CHECK (((error_code IS NULL) OR (error_code ~ ''^[a-z_]{1,64}$''::text)))',
          'starter_crew_members_pkey=PRIMARY KEY (id)',
          'starter_crew_members_setup_id_starter_crew_setups_id_fk=FOREIGN KEY (setup_id) REFERENCES starter_crew_setups(id) ON DELETE CASCADE',
          'starter_crew_members_state_check=CHECK ((state = ANY (ARRAY[''pending''::text, ''creating''::text, ''created''::text, ''failed''::text])))',
          'starter_crew_members_template_check=CHECK ((template_id = ANY (ARRAY[''pr-reviewer''::text, ''dev-agent''::text, ''daily-briefer''::text, ''inbox-triage''::text, ''research-analyst''::text, ''travel-assistant''::text])))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.starter_crew_members'))
        IS DISTINCT FROM ARRAY[6,8,9] OR
      EXISTS (SELECT FROM pg_attrdef d WHERE d.adrelid = to_regclass('public.starter_crew_members')
        AND ((d.adnum = 6 AND pg_get_expr(d.adbin, d.adrelid) <> '''pending''::text')
          OR (d.adnum IN (8,9) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()'))) OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'starter_crew_members')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX starter_crew_members_owner_id_idx ON public.starter_crew_members USING btree (owner_id)',
          'CREATE UNIQUE INDEX starter_crew_members_pkey ON public.starter_crew_members USING btree (id)',
          'CREATE UNIQUE INDEX starter_crew_members_setup_template_idx ON public.starter_crew_members USING btree (setup_id, template_id)']) THEN
     RAISE EXCEPTION 'unexpected starter crew members schema';
   END IF;
   IF to_regclass('public.crews') IS NOT NULL AND (
       (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = to_regclass('public.crews') AND attnum > 0 AND NOT attisdropped)
         IS DISTINCT FROM ARRAY['id','owner_id','name','description','created_at','updated_at'] OR
       (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = to_regclass('public.crews') AND attnum > 0 AND NOT attisdropped)
         IS DISTINCT FROM ARRAY['uuid','uuid','text','text','timestamp with time zone','timestamp with time zone'] OR
       (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = to_regclass('public.crews') AND attnum > 0 AND NOT attisdropped)
         IS DISTINCT FROM ARRAY[true,true,true,true,true,true] OR
       (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.crews'))
         IS DISTINCT FROM ARRAY[
           'crews_description_check=CHECK (((char_length(description) >= 0) AND (char_length(description) <= 500)))',
           'crews_name_check=CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80)))',
           'crews_pkey=PRIMARY KEY (id)'] OR
       (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.crews'))
         IS DISTINCT FROM ARRAY[4,5,6] OR
       EXISTS (SELECT FROM pg_attrdef d WHERE d.adrelid = to_regclass('public.crews')
         AND ((d.adnum = 4 AND pg_get_expr(d.adbin, d.adrelid) <> '''''::text')
           OR (d.adnum IN (5,6) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()'))) OR
       (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'crews')
         IS DISTINCT FROM ARRAY[
           'CREATE INDEX crews_owner_id_idx ON public.crews USING btree (owner_id)',
           'CREATE UNIQUE INDEX crews_pkey ON public.crews USING btree (id)']) THEN
     RAISE EXCEPTION 'unexpected crews schema';
   END IF;
   IF to_regclass('public.crew_members') IS NOT NULL AND (
       (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = to_regclass('public.crew_members') AND attnum > 0 AND NOT attisdropped)
         IS DISTINCT FROM ARRAY['id','owner_id','crew_id','agent_id','agent_name','role','state','error_code','created_at','updated_at'] OR
       (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = to_regclass('public.crew_members') AND attnum > 0 AND NOT attisdropped)
         IS DISTINCT FROM ARRAY['uuid','uuid','uuid','uuid','text','text','text','text','timestamp with time zone','timestamp with time zone'] OR
       (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = to_regclass('public.crew_members') AND attnum > 0 AND NOT attisdropped)
         IS DISTINCT FROM ARRAY[true,true,true,true,true,true,true,false,true,true] OR
       (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.crew_members'))
         IS DISTINCT FROM ARRAY[
           'crew_members_crew_id_crews_id_fk=FOREIGN KEY (crew_id) REFERENCES crews(id) ON DELETE CASCADE',
           'crew_members_error_check=CHECK (((error_code IS NULL) OR (error_code ~ ''^[a-z_]{1,64}$''::text)))',
           'crew_members_name_check=CHECK (((char_length(agent_name) >= 1) AND (char_length(agent_name) <= 80)))',
           'crew_members_pkey=PRIMARY KEY (id)',
           'crew_members_role_check=CHECK (((char_length(role) >= 1) AND (char_length(role) <= 80)))',
           'crew_members_state_check=CHECK ((state = ANY (ARRAY[''pending''::text, ''creating''::text, ''ready''::text, ''failed''::text])))'] OR
       (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.crew_members'))
         IS DISTINCT FROM ARRAY[7,9,10] OR
       EXISTS (SELECT FROM pg_attrdef d WHERE d.adrelid = to_regclass('public.crew_members')
         AND ((d.adnum = 7 AND pg_get_expr(d.adbin, d.adrelid) <> '''pending''::text')
           OR (d.adnum IN (9,10) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()'))) OR
       (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'crew_members')
         IS DISTINCT FROM ARRAY[
           'CREATE UNIQUE INDEX crew_members_crew_agent_idx ON public.crew_members USING btree (crew_id, agent_id)',
           'CREATE INDEX crew_members_crew_id_idx ON public.crew_members USING btree (crew_id)',
           'CREATE INDEX crew_members_owner_id_idx ON public.crew_members USING btree (owner_id)',
           'CREATE UNIQUE INDEX crew_members_pkey ON public.crew_members USING btree (id)']) THEN
     RAISE EXCEPTION 'unexpected crew members schema';
   END IF;
  IF to_regclass('public.crew_report_settings') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.crew_report_settings') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['owner_id','enabled','recipient_agent_id','local_time','created_at','updated_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.crew_report_settings') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','boolean','uuid','text','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.crew_report_settings') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,false,true,true,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.crew_report_settings'))
        IS DISTINCT FROM ARRAY[
          'crew_report_settings_pkey=PRIMARY KEY (owner_id)',
          'crew_report_settings_recipient_agent_id_agents_id_fk=FOREIGN KEY (recipient_agent_id) REFERENCES agents(id) ON DELETE SET NULL',
          'crew_report_settings_time_check=CHECK ((local_time ~ ''^([01][0-9]|2[0-3]):[0-5][0-9]$''::text))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.crew_report_settings'))
        IS DISTINCT FROM ARRAY[2,4,5,6] OR
      EXISTS (SELECT FROM pg_attrdef d WHERE d.adrelid = to_regclass('public.crew_report_settings')
        AND ((d.adnum = 2 AND pg_get_expr(d.adbin, d.adrelid) <> 'false')
          OR (d.adnum = 4 AND pg_get_expr(d.adbin, d.adrelid) <> '''09:00''::text')
          OR (d.adnum IN (5,6) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()'))) OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'crew_report_settings')
        IS DISTINCT FROM ARRAY[
          'CREATE UNIQUE INDEX crew_report_settings_pkey ON public.crew_report_settings USING btree (owner_id)']) THEN
    RAISE EXCEPTION 'unexpected crew report settings schema';
  END IF;
  IF to_regclass('public.crew_report_deliveries') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.crew_report_deliveries') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','recipient_agent_id','scheduled_at','timezone','message_id','created_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.crew_report_deliveries') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','timestamp with time zone','text','uuid','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.crew_report_deliveries') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,true,false,true] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.crew_report_deliveries'))
        IS DISTINCT FROM ARRAY[
          'crew_report_deliveries_message_id_messages_id_fk=FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL',
          'crew_report_deliveries_pkey=PRIMARY KEY (id)',
          'crew_report_deliveries_timezone_check=CHECK (((char_length(timezone) >= 1) AND (char_length(timezone) <= 100)))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.crew_report_deliveries'))
        IS DISTINCT FROM ARRAY[7] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.crew_report_deliveries') AND pg_get_expr(adbin, adrelid) <> 'now()') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'crew_report_deliveries')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX crew_report_deliveries_owner_id_idx ON public.crew_report_deliveries USING btree (owner_id)',
          'CREATE UNIQUE INDEX crew_report_deliveries_owner_scheduled_idx ON public.crew_report_deliveries USING btree (owner_id, scheduled_at)',
          'CREATE UNIQUE INDEX crew_report_deliveries_pkey ON public.crew_report_deliveries USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected crew report deliveries schema';
  END IF;
  IF to_regclass('public.audit_log') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.audit_log') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','seq','kind','agent_id','run_id','ref','code','host','source_ref','entry_json','entry_hash','prev_hash','signature','key_id','created_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.audit_log') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','bigint','text','uuid','uuid','text','text','text','text','text','text','text','text','text','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.audit_log') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,true,false,false,false,false,false,false,true,true,true,true,true,true] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.audit_log'))
        IS DISTINCT FROM ARRAY[16] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.audit_log') AND pg_get_expr(adbin, adrelid) <> 'now()') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'audit_log')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX audit_log_owner_created_idx ON public.audit_log USING btree (owner_id, created_at DESC NULLS LAST)',
          'CREATE UNIQUE INDEX audit_log_owner_seq_idx ON public.audit_log USING btree (owner_id, seq)',
          'CREATE UNIQUE INDEX audit_log_owner_source_ref_idx ON public.audit_log USING btree (owner_id, source_ref) WHERE (source_ref IS NOT NULL)',
          'CREATE UNIQUE INDEX audit_log_pkey ON public.audit_log USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected audit log schema';
  END IF;
  IF to_regclass('public.agent_policies') IS NOT NULL AND
      EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agent_policies') AND attname = 'memory_mode' AND NOT attisdropped) AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.agent_policies') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['agent_id','owner_id','tools','domains','actions','memory_scopes','updated_at','memory_mode'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.agent_policies') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','text[]','text[]','text[]','text[]','timestamp with time zone','text'] OR
      EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agent_policies')
        AND attnum > 0 AND NOT attisdropped AND NOT attnotnull) OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.agent_policies'))
        IS DISTINCT FROM ARRAY[
          'agent_policies_actions_check=CHECK ((cardinality(actions) <= 64))',
          'agent_policies_agent_id_agents_id_fk=FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE',
          'agent_policies_domains_check=CHECK ((cardinality(domains) <= 64))',
          'agent_policies_memory_mode_check=CHECK ((memory_mode = ANY (ARRAY[''auto''::text, ''ask''::text])))',
          'agent_policies_memory_scopes_check=CHECK ((cardinality(memory_scopes) <= 3))',
          'agent_policies_pkey=PRIMARY KEY (agent_id)',
          'agent_policies_tools_check=CHECK ((cardinality(tools) <= 64))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.agent_policies'))
        IS DISTINCT FROM ARRAY[3,4,5,6,7,8] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.agent_policies') AND adnum BETWEEN 3 AND 6
        AND pg_get_expr(adbin, adrelid) <> '''{}''::text[]') OR
      (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = to_regclass('public.agent_policies') AND adnum = 7)
        IS DISTINCT FROM 'now()' OR
      (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = to_regclass('public.agent_policies') AND adnum = 8)
        IS DISTINCT FROM '''auto''::text' OR
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = to_regclass('public.agent_policies') AND conname = 'agent_policies_agent_id_agents_id_fk')
        IS DISTINCT FROM 'FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE' OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'agent_policies')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX agent_policies_owner_id_idx ON public.agent_policies USING btree (owner_id)',
          'CREATE UNIQUE INDEX agent_policies_pkey ON public.agent_policies USING btree (agent_id)']) THEN
    RAISE EXCEPTION 'unexpected agent policies schema';
  END IF;
  IF to_regclass('public.agent_policies') IS NOT NULL AND
      NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agent_policies') AND attname = 'memory_mode' AND NOT attisdropped) AND (
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
    RAISE EXCEPTION 'unexpected legacy agent policies schema';
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
  IF to_regclass('public.teach_recordings') IS NULL AND to_regclass('public.messages') IS NOT NULL AND (
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
          'messages_card_type_check=CHECK ((card_type = ANY (ARRAY[''message''::text, ''clarification''::text, ''tool_connection''::text, ''routine''::text, ''file''::text, ''budget_warning''::text, ''budget_paused''::text])))',
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
          OR (d.adnum IN (8,9) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()')
          OR (d.adnum = 10 AND pg_get_expr(d.adbin, d.adrelid) <> '''fixed''::text'))) OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'providers')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX providers_owner_id_idx ON public.providers USING btree (owner_id)',
          'CREATE UNIQUE INDEX providers_pkey ON public.providers USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected providers schema';
  END IF;
  IF to_regclass('public.model_roles') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.model_roles') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.model_roles') AND attname = 'routing' AND NOT attisdropped)
          THEN ARRAY['id','owner_id','role','provider_id','model','use_main_key','mode','created_at','updated_at','routing','hard_model']
          ELSE ARRAY['id','owner_id','role','provider_id','model','use_main_key','mode','created_at','updated_at'] END) OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.model_roles') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.model_roles') AND attname = 'routing' AND NOT attisdropped)
          THEN ARRAY['uuid','uuid','text','uuid','text','boolean','text','timestamp with time zone','timestamp with time zone','text','text']
          ELSE ARRAY['uuid','uuid','text','uuid','text','boolean','text','timestamp with time zone','timestamp with time zone'] END) OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.model_roles') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.model_roles') AND attname = 'routing' AND NOT attisdropped)
          THEN ARRAY[true,true,true,false,false,true,true,true,true,true,false]
          ELSE ARRAY[true,true,true,false,false,true,true,true,true] END) OR
      ((SELECT array_agg(conname::text || ': ' || pg_get_constraintdef(oid) ORDER BY conname)
       FROM pg_constraint WHERE conrelid = to_regclass('public.model_roles'))
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.model_roles') AND attname = 'routing' AND NOT attisdropped)
          THEN ARRAY[
          'model_roles_main_shape_check: CHECK (((role <> ''main''::text) OR ((mode = ''active''::text) AND (provider_id IS NOT NULL) AND (model IS NOT NULL) AND (use_main_key = false))))',
          'model_roles_mode_check: CHECK ((mode = ANY (ARRAY[''active''::text, ''off''::text, ''meta''::text])))',
          'model_roles_pkey: PRIMARY KEY (id)',
          'model_roles_provider_id_providers_id_fk: FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE RESTRICT',
          'model_roles_role_check: CHECK ((role = ANY (ARRAY[''main''::text, ''sam''::text])))',
          'model_roles_routing_check: CHECK (((routing = ANY (ARRAY[''fixed''::text, ''auto''::text])) AND ((routing = ''fixed''::text) OR (hard_model IS NOT NULL)) AND ((role = ''main''::text) OR ((routing = ''fixed''::text) AND (hard_model IS NULL)))))',
          'model_roles_sam_shape_check: CHECK (((role <> ''sam''::text) OR (((mode = ''off''::text) AND (provider_id IS NULL) AND (model IS NULL) AND (use_main_key = false)) OR ((mode = ''meta''::text) AND (provider_id IS NOT NULL) AND (model IS NOT NULL)))))'
        ]
          ELSE ARRAY[
          'model_roles_main_shape_check: CHECK (((role <> ''main''::text) OR ((mode = ''active''::text) AND (provider_id IS NOT NULL) AND (model IS NOT NULL) AND (use_main_key = false))))',
          'model_roles_mode_check: CHECK ((mode = ANY (ARRAY[''active''::text, ''off''::text, ''meta''::text])))',
          'model_roles_pkey: PRIMARY KEY (id)',
          'model_roles_provider_id_providers_id_fk: FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE RESTRICT',
          'model_roles_role_check: CHECK ((role = ANY (ARRAY[''main''::text, ''sam''::text])))',
          'model_roles_sam_shape_check: CHECK (((role <> ''sam''::text) OR (((mode = ''off''::text) AND (provider_id IS NULL) AND (model IS NULL) AND (use_main_key = false)) OR ((mode = ''meta''::text) AND (provider_id IS NOT NULL) AND (model IS NOT NULL)))))'
        ] END) AND
      (SELECT array_agg(conname::text || ': ' || pg_get_constraintdef(oid) ORDER BY conname)
       FROM pg_constraint WHERE conrelid = to_regclass('public.model_roles'))
        IS DISTINCT FROM ARRAY[
          'model_roles_background_shape_check: CHECK (((role <> ''background''::text) OR ((mode = ''active''::text) AND (provider_id IS NOT NULL) AND (model IS NOT NULL) AND (use_main_key = false))))',
          'model_roles_main_shape_check: CHECK (((role <> ''main''::text) OR ((mode = ''active''::text) AND (provider_id IS NOT NULL) AND (model IS NOT NULL) AND (use_main_key = false))))',
          'model_roles_mode_check: CHECK ((mode = ANY (ARRAY[''active''::text, ''off''::text, ''meta''::text])))',
          'model_roles_pkey: PRIMARY KEY (id)',
          'model_roles_provider_id_providers_id_fk: FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE RESTRICT',
          'model_roles_role_check: CHECK ((role = ANY (ARRAY[''main''::text, ''sam''::text, ''background''::text])))',
          'model_roles_routing_check: CHECK (((routing = ANY (ARRAY[''fixed''::text, ''auto''::text])) AND ((routing = ''fixed''::text) OR (hard_model IS NOT NULL)) AND ((role = ''main''::text) OR ((routing = ''fixed''::text) AND (hard_model IS NULL)))))',
          'model_roles_sam_shape_check: CHECK (((role <> ''sam''::text) OR (((mode = ''off''::text) AND (provider_id IS NULL) AND (model IS NULL) AND (use_main_key = false)) OR ((mode = ''meta''::text) AND (provider_id IS NOT NULL) AND (model IS NOT NULL)))))'
        ]) OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.model_roles'))
        IS DISTINCT FROM (CASE WHEN EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.model_roles') AND attname = 'routing' AND NOT attisdropped) THEN ARRAY[6,8,9,10] ELSE ARRAY[6,8,9] END) OR
      EXISTS (SELECT FROM pg_attrdef d WHERE d.adrelid = to_regclass('public.model_roles')
        AND ((d.adnum = 6 AND pg_get_expr(d.adbin, d.adrelid) <> 'false')
          OR (d.adnum IN (8,9) AND pg_get_expr(d.adbin, d.adrelid) <> 'now()')
          OR (d.adnum = 10 AND pg_get_expr(d.adbin, d.adrelid) <> '''fixed''::text'))) OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'model_roles')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX model_roles_owner_id_idx ON public.model_roles USING btree (owner_id)',
          'CREATE UNIQUE INDEX model_roles_owner_role_idx ON public.model_roles USING btree (owner_id, role)',
          'CREATE UNIQUE INDEX model_roles_pkey ON public.model_roles USING btree (id)',
          'CREATE INDEX model_roles_provider_id_idx ON public.model_roles USING btree (provider_id)']) THEN
    RAISE EXCEPTION 'unexpected model roles schema';
  END IF;
  IF to_regclass('public.runs') IS NOT NULL AND EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.runs') AND attname = 'heartbeat_at' AND NOT attisdropped) AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.runs') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','agent_id','branch_of','header_json','header_hash','key_id','public_key','started_at','status','ended_at','step_count','head_hash','usage','signature','heartbeat_at','cancel_requested_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.runs') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','uuid','text','text','text','text','timestamp with time zone','text','timestamp with time zone','integer','text','jsonb','text','timestamp with time zone','timestamp with time zone'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.runs') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,false,true,true,true,true,true,true,false,false,false,false,false,false,false] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.runs'))
        IS DISTINCT FROM ARRAY[
          'runs_pkey=PRIMARY KEY (id)',
          'runs_sealed_check=CHECK ((((signature IS NULL) AND (ended_at IS NULL) AND (step_count IS NULL) AND (head_hash IS NULL) AND (usage IS NULL)) OR ((signature IS NOT NULL) AND (ended_at IS NOT NULL) AND (step_count IS NOT NULL) AND (head_hash IS NOT NULL) AND (usage IS NOT NULL))))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.runs'))
        IS DISTINCT FROM ARRAY[10] OR
      (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = to_regclass('public.runs') AND adnum = 10)
        IS DISTINCT FROM '''running''::text' OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'runs')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX runs_heartbeat_idx ON public.runs USING btree (heartbeat_at) WHERE (signature IS NULL)',
          'CREATE INDEX runs_owner_id_idx ON public.runs USING btree (owner_id)',
          'CREATE INDEX runs_owner_started_idx ON public.runs USING btree (owner_id, started_at DESC NULLS LAST)',
          'CREATE UNIQUE INDEX runs_pkey ON public.runs USING btree (id)']) THEN
    RAISE EXCEPTION 'unexpected runs schema';
  END IF;
  IF to_regclass('public.runs') IS NOT NULL AND NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.runs') AND attname = 'heartbeat_at' AND NOT attisdropped) AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.runs') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','agent_id','branch_of','header_json','header_hash','key_id','public_key','started_at','status','ended_at','step_count','head_hash','usage','signature'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.runs') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','uuid','text','text','text','text','timestamp with time zone','text','timestamp with time zone','integer','text','jsonb','text'] OR
      (SELECT array_agg(attnotnull ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.runs') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY[true,true,true,false,true,true,true,true,true,true,false,false,false,false,false] OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.runs'))
        IS DISTINCT FROM ARRAY[
          'runs_pkey=PRIMARY KEY (id)',
          'runs_sealed_check=CHECK ((((signature IS NULL) AND (ended_at IS NULL) AND (step_count IS NULL) AND (head_hash IS NULL) AND (usage IS NULL)) OR ((signature IS NOT NULL) AND (ended_at IS NOT NULL) AND (step_count IS NOT NULL) AND (head_hash IS NOT NULL) AND (usage IS NOT NULL))))'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.runs'))
        IS DISTINCT FROM ARRAY[10] OR
      (SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid = to_regclass('public.runs') AND adnum = 10)
        IS DISTINCT FROM '''running''::text' OR
      ((SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'runs')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX runs_owner_id_idx ON public.runs USING btree (owner_id)',
          'CREATE UNIQUE INDEX runs_pkey ON public.runs USING btree (id)'] AND
       (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'runs')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX runs_owner_id_idx ON public.runs USING btree (owner_id)',
          'CREATE INDEX runs_owner_started_idx ON public.runs USING btree (owner_id, started_at DESC NULLS LAST)',
          'CREATE UNIQUE INDEX runs_pkey ON public.runs USING btree (id)'])) THEN
    RAISE EXCEPTION 'unexpected runs schema';
  END IF;
  IF to_regclass('public.steps') IS NOT NULL AND (
      (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.steps') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['id','owner_id','run_id','idx','receipt_json','receipt_hash','prev_hash','created_at'] OR
      (SELECT array_agg(format_type(atttypid, atttypmod) ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = to_regclass('public.steps') AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM ARRAY['uuid','uuid','uuid','integer','text','text','text','timestamp with time zone'] OR
      EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.steps')
        AND attnum > 0 AND NOT attisdropped AND NOT attnotnull) OR
      (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint WHERE conrelid = to_regclass('public.steps'))
        IS DISTINCT FROM ARRAY[
          'steps_pkey=PRIMARY KEY (id)',
          'steps_run_id_runs_id_fk=FOREIGN KEY (run_id) REFERENCES runs(id)'] OR
      (SELECT array_agg(adnum::integer ORDER BY adnum) FROM pg_attrdef WHERE adrelid = to_regclass('public.steps'))
        IS DISTINCT FROM ARRAY[8] OR
      EXISTS (SELECT FROM pg_attrdef WHERE adrelid = to_regclass('public.steps') AND pg_get_expr(adbin, adrelid) <> 'now()') OR
      (SELECT array_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'steps')
        IS DISTINCT FROM ARRAY[
          'CREATE INDEX steps_owner_id_idx ON public.steps USING btree (owner_id)',
          'CREATE UNIQUE INDEX steps_pkey ON public.steps USING btree (id)',
          'CREATE UNIQUE INDEX steps_run_idx_idx ON public.steps USING btree (run_id, idx)']) THEN
    RAISE EXCEPTION 'unexpected steps schema';
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
       (migration_count >= 6) <> ((to_regclass('public.providers') IS NOT NULL) AND (to_regclass('public.model_roles') IS NOT NULL)) OR
       (migration_count >= 8) <> (to_regclass('public.model_roles') IS NOT NULL AND EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.model_roles') AND attname = 'routing' AND NOT attisdropped)) OR
       (migration_count >= 10) <> (to_regclass('public.runs') IS NOT NULL AND to_regclass('public.steps') IS NOT NULL) OR
       (migration_count >= 11) <> (to_regclass('public.step_evidence') IS NOT NULL) OR
       (migration_count >= 12) <> (to_regclass('public.model_prices') IS NOT NULL AND to_regclass('public.cost_entries') IS NOT NULL AND EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'attention_reason' AND NOT attisdropped)) OR
       (migration_count >= 13) <> (to_regclass('public.checkpoints') IS NOT NULL) OR
       (migration_count >= 14) <> (to_regclass('public.teach_recordings') IS NOT NULL) OR
       (migration_count >= 15) <> (to_regclass('public.routines') IS NOT NULL) OR
       (migration_count >= 16) <> (to_regclass('public.replay_scripts') IS NOT NULL) OR
       (migration_count >= 17) <> (to_regclass('public.skills') IS NOT NULL AND to_regclass('public.skill_versions') IS NOT NULL) OR
       (migration_count >= 18) <> (to_regclass('public.run_meta') IS NOT NULL) OR
       (migration_count >= 19) <> (to_regclass('public.replay_script_versions') IS NOT NULL AND to_regclass('public.replay_script_proposals') IS NOT NULL) OR
       (migration_count >= 20) <> (to_regclass('pgboss.version') IS NOT NULL AND EXISTS (
         SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.run_meta') AND attname = 'execution_id' AND NOT attisdropped)) OR
       (migration_count >= 21) <> (to_regclass('public.agent_canaries') IS NOT NULL AND to_regclass('public.security_events') IS NOT NULL) OR
       (migration_count >= 22) <> (to_regclass('public.approvals') IS NOT NULL AND to_regclass('public.permissions') IS NOT NULL AND to_regclass('public.permission_uses') IS NOT NULL) OR
       (migration_count >= 23) <> (to_regclass('public.agents') IS NOT NULL AND EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'astra_mode' AND NOT attisdropped)) OR
       (migration_count >= 24) <> (to_regclass('public.audit_log') IS NOT NULL AND EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.owner') AND attname = 'crew_stopped_at' AND NOT attisdropped)) OR
       (migration_count >= 25) <> (to_regclass('public.memory_entries') IS NOT NULL AND to_regclass('public.memory_versions') IS NOT NULL) OR
       (migration_count >= 26) <> (to_regclass('public.memory_changes') IS NOT NULL) OR
       (migration_count >= 27) <> (to_regclass('public.connections') IS NOT NULL) OR
       (migration_count >= 28) <> (to_regclass('public.mcp_servers') IS NOT NULL) OR
       (migration_count >= 29) <> (to_regclass('public.composio_keys') IS NOT NULL AND to_regclass('public.composio_accounts') IS NOT NULL) OR
       (migration_count >= 31) <> (to_regclass('public.github_device_flows') IS NOT NULL AND EXISTS (
         SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.connections') AND attname = 'source' AND NOT attisdropped)) OR
       (migration_count >= 32) <> (EXISTS (
         SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.runs') AND attname = 'heartbeat_at' AND NOT attisdropped)) OR
        (migration_count >= 33) <> (to_regclass('public.starter_crew_setups') IS NOT NULL AND to_regclass('public.starter_crew_members') IS NOT NULL AND
          to_regclass('public.crew_report_settings') IS NOT NULL AND to_regclass('public.crew_report_deliveries') IS NOT NULL) OR
        (migration_count >= 35) <> (EXISTS (
          SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.cost_entries') AND attname = 'background_job_id' AND NOT attisdropped)) OR
        (migration_count >= 36) <> (to_regclass('public.crews') IS NOT NULL AND to_regclass('public.crew_members') IS NOT NULL) OR
        (migration_count >= 37) <> (EXISTS (SELECT FROM pg_attribute WHERE attrelid = to_regclass('public.agents') AND attname = 'avatar_variant' AND NOT attisdropped)) THEN
      RAISE EXCEPTION 'inconsistent migration history';
    END IF;
  ELSIF to_regclass('public.owner') IS NOT NULL OR to_regclass('public.sessions') IS NOT NULL OR
        to_regclass('public.agents') IS NOT NULL OR to_regclass('public.agent_policies') IS NOT NULL OR
        to_regclass('public.chat_sessions') IS NOT NULL OR to_regclass('public.messages') IS NOT NULL OR
        to_regclass('public.providers') IS NOT NULL OR to_regclass('public.model_roles') IS NOT NULL OR
        to_regclass('public.runs') IS NOT NULL OR to_regclass('public.steps') IS NOT NULL OR to_regclass('public.step_evidence') IS NOT NULL OR
        to_regclass('public.model_prices') IS NOT NULL OR to_regclass('public.cost_entries') IS NOT NULL OR to_regclass('public.checkpoints') IS NOT NULL OR to_regclass('public.teach_recordings') IS NOT NULL OR to_regclass('public.routines') IS NOT NULL OR to_regclass('public.replay_scripts') IS NOT NULL OR
        to_regclass('public.skills') IS NOT NULL OR to_regclass('public.skill_versions') IS NOT NULL OR
        to_regclass('public.run_meta') IS NOT NULL OR
        to_regclass('public.replay_script_versions') IS NOT NULL OR to_regclass('public.replay_script_proposals') IS NOT NULL OR
        to_regclass('public.agent_canaries') IS NOT NULL OR to_regclass('public.security_events') IS NOT NULL OR
        to_regclass('public.approvals') IS NOT NULL OR to_regclass('public.permissions') IS NOT NULL OR
        to_regclass('public.permission_uses') IS NOT NULL OR
        to_regclass('public.audit_log') IS NOT NULL OR
        to_regclass('public.memory_entries') IS NOT NULL OR to_regclass('public.memory_versions') IS NOT NULL OR
        to_regclass('public.memory_changes') IS NOT NULL OR
        to_regclass('public.connections') IS NOT NULL OR
        to_regclass('public.github_device_flows') IS NOT NULL OR
        to_regclass('public.mcp_servers') IS NOT NULL OR
        to_regclass('public.composio_keys') IS NOT NULL OR to_regclass('public.composio_accounts') IS NOT NULL OR
         to_regclass('public.starter_crew_setups') IS NOT NULL OR to_regclass('public.starter_crew_members') IS NOT NULL OR
         to_regclass('public.crew_report_settings') IS NOT NULL OR to_regclass('public.crew_report_deliveries') IS NOT NULL OR
         to_regclass('public.crews') IS NOT NULL OR to_regclass('public.crew_members') IS NOT NULL OR
         to_regclass('pgboss.version') IS NOT NULL THEN
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
  IF to_regnamespace('pgboss') IS NOT NULL THEN
    ALTER SCHEMA pgboss OWNER TO eclipse_migrator;
    REVOKE CREATE ON SCHEMA pgboss FROM PUBLIC, eclipse_app;
    GRANT USAGE ON SCHEMA pgboss TO eclipse_app;
    GRANT USAGE ON TYPE pgboss.job_state TO eclipse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO eclipse_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA pgboss TO eclipse_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO eclipse_app;
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
  IF to_regclass('public.agent_canaries') IS NOT NULL THEN
    ALTER TABLE public.agent_canaries OWNER TO eclipse_migrator;
    REVOKE ALL ON public.agent_canaries FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.agent_canaries TO eclipse_app;
  END IF;
  IF to_regclass('public.security_events') IS NOT NULL THEN
    ALTER TABLE public.security_events OWNER TO eclipse_migrator;
    REVOKE ALL ON public.security_events FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.security_events TO eclipse_app;
  END IF;
  IF to_regclass('public.approvals') IS NOT NULL THEN
    ALTER TABLE public.approvals OWNER TO eclipse_migrator;
    REVOKE ALL ON public.approvals FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.approvals TO eclipse_app;
  END IF;
  IF to_regclass('public.permissions') IS NOT NULL THEN
    ALTER TABLE public.permissions OWNER TO eclipse_migrator;
    REVOKE ALL ON public.permissions FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.permissions TO eclipse_app;
  END IF;
  IF to_regclass('public.permission_uses') IS NOT NULL THEN
    ALTER TABLE public.permission_uses OWNER TO eclipse_migrator;
    REVOKE ALL ON public.permission_uses FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.permission_uses TO eclipse_app;
  END IF;
  IF to_regclass('public.audit_log') IS NOT NULL THEN
    ALTER TABLE public.audit_log OWNER TO eclipse_migrator;
    REVOKE ALL ON public.audit_log FROM PUBLIC, eclipse_app;
    -- TASK-052: append-only. No UPDATE, no DELETE, no TRUNCATE for the runtime role.
    GRANT SELECT, INSERT ON public.audit_log TO eclipse_app;
  END IF;
  IF to_regclass('public.memory_entries') IS NOT NULL THEN
    ALTER TABLE public.memory_entries OWNER TO eclipse_migrator;
    REVOKE ALL ON public.memory_entries FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.memory_entries TO eclipse_app;
  END IF;
  IF to_regclass('public.memory_versions') IS NOT NULL THEN
    ALTER TABLE public.memory_versions OWNER TO eclipse_migrator;
    REVOKE ALL ON public.memory_versions FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.memory_versions TO eclipse_app;
  END IF;
  IF to_regclass('public.memory_changes') IS NOT NULL THEN
    ALTER TABLE public.memory_changes OWNER TO eclipse_migrator;
    REVOKE ALL ON public.memory_changes FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.memory_changes TO eclipse_app;
  END IF;
  IF to_regclass('public.memory_review_state') IS NOT NULL THEN
    ALTER TABLE public.memory_review_state OWNER TO eclipse_migrator;
    REVOKE ALL ON public.memory_review_state FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.memory_review_state TO eclipse_app;
  END IF;
  IF to_regclass('public.connections') IS NOT NULL THEN
    ALTER TABLE public.connections OWNER TO eclipse_migrator;
    REVOKE ALL ON public.connections FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.connections TO eclipse_app;
  END IF;
  IF to_regclass('public.github_device_flows') IS NOT NULL THEN
    ALTER TABLE public.github_device_flows OWNER TO eclipse_migrator;
    REVOKE ALL ON public.github_device_flows FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.github_device_flows TO eclipse_app;
  END IF;
  IF to_regclass('public.mcp_servers') IS NOT NULL THEN
    ALTER TABLE public.mcp_servers OWNER TO eclipse_migrator;
    REVOKE ALL ON public.mcp_servers FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.mcp_servers TO eclipse_app;
  END IF;
  IF to_regclass('public.composio_keys') IS NOT NULL THEN
    ALTER TABLE public.composio_keys OWNER TO eclipse_migrator;
    REVOKE ALL ON public.composio_keys FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.composio_keys TO eclipse_app;
  END IF;
  IF to_regclass('public.composio_accounts') IS NOT NULL THEN
    ALTER TABLE public.composio_accounts OWNER TO eclipse_migrator;
    REVOKE ALL ON public.composio_accounts FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.composio_accounts TO eclipse_app;
  END IF;
  IF to_regclass('public.starter_crew_setups') IS NOT NULL THEN
    ALTER TABLE public.starter_crew_setups OWNER TO eclipse_migrator;
    REVOKE ALL ON public.starter_crew_setups FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.starter_crew_setups TO eclipse_app;
  END IF;
  IF to_regclass('public.starter_crew_members') IS NOT NULL THEN
    ALTER TABLE public.starter_crew_members OWNER TO eclipse_migrator;
    REVOKE ALL ON public.starter_crew_members FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.starter_crew_members TO eclipse_app;
  END IF;
  IF to_regclass('public.crew_report_settings') IS NOT NULL THEN
    ALTER TABLE public.crew_report_settings OWNER TO eclipse_migrator;
    REVOKE ALL ON public.crew_report_settings FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.crew_report_settings TO eclipse_app;
  END IF;
  IF to_regclass('public.crew_report_deliveries') IS NOT NULL THEN
    ALTER TABLE public.crew_report_deliveries OWNER TO eclipse_migrator;
    REVOKE ALL ON public.crew_report_deliveries FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.crew_report_deliveries TO eclipse_app;
  END IF;
  IF to_regclass('public.crews') IS NOT NULL THEN
    ALTER TABLE public.crews OWNER TO eclipse_migrator;
    REVOKE ALL ON public.crews FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.crews TO eclipse_app;
  END IF;
  IF to_regclass('public.crew_members') IS NOT NULL THEN
    ALTER TABLE public.crew_members OWNER TO eclipse_migrator;
    REVOKE ALL ON public.crew_members FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.crew_members TO eclipse_app;
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
  IF to_regclass('public.replay_scripts') IS NOT NULL THEN
    ALTER TABLE public.replay_scripts OWNER TO eclipse_migrator;
    REVOKE ALL ON public.replay_scripts FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, DELETE ON public.replay_scripts TO eclipse_app;
  END IF;
  IF to_regclass('public.replay_script_versions') IS NOT NULL THEN
    ALTER TABLE public.replay_script_versions OWNER TO eclipse_migrator;
    REVOKE ALL ON public.replay_script_versions FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.replay_script_versions TO eclipse_app;
  END IF;
  IF to_regclass('public.replay_script_proposals') IS NOT NULL THEN
    ALTER TABLE public.replay_script_proposals OWNER TO eclipse_migrator;
    REVOKE ALL ON public.replay_script_proposals FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.replay_script_proposals TO eclipse_app;
  END IF;
  IF to_regclass('public.run_meta') IS NOT NULL THEN
    ALTER TABLE public.run_meta OWNER TO eclipse_migrator;
    REVOKE ALL ON public.run_meta FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.run_meta TO eclipse_app;
  END IF;
  IF to_regclass('public.skills') IS NOT NULL THEN
    ALTER TABLE public.skills OWNER TO eclipse_migrator;
    REVOKE ALL ON public.skills FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.skills TO eclipse_app;
  END IF;
  IF to_regclass('public.skill_versions') IS NOT NULL THEN
    ALTER TABLE public.skill_versions OWNER TO eclipse_migrator;
    REVOKE ALL ON public.skill_versions FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.skill_versions TO eclipse_app;
  END IF;
  IF to_regclass('public.routines') IS NOT NULL THEN
    ALTER TABLE public.routines OWNER TO eclipse_migrator;
    REVOKE ALL ON public.routines FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.routines TO eclipse_app;
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
  IF to_regclass('public.runs') IS NOT NULL THEN
    ALTER TABLE public.runs OWNER TO eclipse_migrator;
    REVOKE ALL ON public.runs FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.runs TO eclipse_app;
  END IF;
  IF to_regclass('public.steps') IS NOT NULL THEN
    ALTER TABLE public.steps OWNER TO eclipse_migrator;
    REVOKE ALL ON public.steps FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.steps TO eclipse_app;
  END IF;
  IF to_regclass('public.step_evidence') IS NOT NULL THEN
    ALTER TABLE public.step_evidence OWNER TO eclipse_migrator;
    REVOKE ALL ON public.step_evidence FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.step_evidence TO eclipse_app;
  END IF;
  IF to_regclass('public.checkpoints') IS NOT NULL THEN
    ALTER TABLE public.checkpoints OWNER TO eclipse_migrator;
    REVOKE ALL ON public.checkpoints FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.checkpoints TO eclipse_app;
  END IF;
  IF to_regclass('public.cost_entries') IS NOT NULL THEN
    ALTER TABLE public.cost_entries OWNER TO eclipse_migrator;
    REVOKE ALL ON public.cost_entries FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT ON public.cost_entries TO eclipse_app;
  END IF;
  IF to_regclass('public.model_prices') IS NOT NULL THEN
    ALTER TABLE public.model_prices OWNER TO eclipse_migrator;
    REVOKE ALL ON public.model_prices FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.model_prices TO eclipse_app;
  END IF;
  IF to_regclass('public.teach_recordings') IS NOT NULL THEN
    ALTER TABLE public.teach_recordings OWNER TO eclipse_migrator;
    REVOKE ALL ON public.teach_recordings FROM PUBLIC, eclipse_app;
    GRANT SELECT, INSERT, UPDATE ON public.teach_recordings TO eclipse_app;
  END IF;
END $$;
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, eclipse_app;
COMMIT;
