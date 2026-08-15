-- ---------------------------------------------------------------------------
-- Runs once, on first initialisation of the data volume, as the database owner.
--
-- Two roles, deliberately:
--   careflow_owner : owns the schema, used only by the migration job.
--   careflow_app   : used by the API and workers. Can read and write rows but has no
--                    DDL rights at all, so an SQL-injection foothold or a bad deploy
--                    cannot drop a table. This mirrors the least-privilege split we use
--                    against RDS in production.
-- ---------------------------------------------------------------------------

-- Required for the GiST exclusion constraints that enforce "no overlapping appointments".
-- btree_gist teaches GiST how to index the scalar `therapist_id` alongside the range,
-- which is what allows a single constraint to mean "per therapist, no overlap".
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'careflow_app') THEN
    CREATE ROLE careflow_app LOGIN PASSWORD 'careflow_local_pw'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE careflow TO careflow_app;
GRANT USAGE ON SCHEMA public TO careflow_app;

-- Explicitly withhold CREATE: the application role must never issue DDL.
REVOKE CREATE ON SCHEMA public FROM careflow_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO careflow_app;

-- Tables do not exist yet (migrations run later), so grant on *future* objects created
-- by the owner. Without this the app role would silently lack access to every new table.
ALTER DEFAULT PRIVILEGES FOR ROLE careflow_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO careflow_app;

ALTER DEFAULT PRIVILEGES FOR ROLE careflow_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO careflow_app;

ALTER DEFAULT PRIVILEGES FOR ROLE careflow_owner IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO careflow_app;

-- Keep every session in UTC. Timezone conversion is an application-boundary concern.
ALTER DATABASE careflow SET timezone TO 'UTC';
