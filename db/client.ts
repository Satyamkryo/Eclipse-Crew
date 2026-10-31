import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

import { requireDatabaseUrl } from "../lib/config/server";
import * as schema from "./schema";

let database: ReturnType<typeof createDatabase> | undefined;

async function createDatabase() {
  const connectionString = requireDatabaseUrl("DATABASE_URL", process.env.DATABASE_URL);

  const pool = new Pool({ connectionString });
  try {
    const result = await drizzle({ client: pool }).execute(sql`SELECT current_user AS current_user, session_user AS session_user,
      r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid) AS has_memberships,
      EXISTS (SELECT 1 FROM pg_class WHERE relowner = r.oid) AS owns_relations,
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid) AS owns_schema,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create,
      has_schema_privilege(current_user, 'drizzle', 'USAGE') AS can_read_migration_schema,
      has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema,
      has_database_privilege(current_user, current_database(), 'TEMP') AS can_temp,
      has_table_privilege(current_user, to_regclass('public.owner'), 'DELETE') AS can_delete_owner,
      has_table_privilege(current_user, to_regclass('public.owner'), 'TRUNCATE') AS can_truncate_owner
      FROM pg_roles r WHERE r.rolname = current_user`);
    const role = result.rows[0];
    if (!role || role.current_user !== "eclipse_app" || role.session_user !== "eclipse_app" ||
      role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication ||
      role.rolbypassrls || role.has_memberships || role.owns_relations || role.owns_schema || role.can_create ||
      role.can_read_migration_schema || role.can_create_schema || role.can_temp || role.can_delete_owner || role.can_truncate_owner) {
      throw new Error("The runtime database role is not sufficiently restricted.");
    }
    return drizzle({ client: pool, schema });
  } catch {
    await pool.end();
    throw new Error("Runtime database connection or role verification failed.");
  }
}

export function getDatabase() {
  database ??= createDatabase().catch((error) => {
    database = undefined;
    throw error;
  });
  return database;
}
