\set ON_ERROR_STOP on
CREATE DATABASE foody_rehearsal OWNER foody_owner;
REVOKE CONNECT, TEMPORARY ON DATABASE foody_rehearsal FROM PUBLIC;
GRANT CONNECT ON DATABASE foody_rehearsal TO foody_owner, ocd_backup;
\connect foody
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%') THEN RAISE EXCEPTION 'Bootstrap requires empty new database'; END IF; END $$;
CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT ALL ON SCHEMA public TO foody_owner;
GRANT ALL ON ALL TABLES IN SCHEMA public TO foody_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO foody_owner;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO foody_owner;
GRANT ALL ON SCHEMA pgmq TO foody_owner;
GRANT ALL ON ALL TABLES IN SCHEMA pgmq TO foody_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgmq TO foody_owner;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgmq TO foody_owner;
\connect postgres
\connect foody_rehearsal
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%') THEN RAISE EXCEPTION 'Bootstrap requires empty new database'; END IF; END $$;
CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT ALL ON SCHEMA public TO foody_owner;
GRANT ALL ON ALL TABLES IN SCHEMA public TO foody_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO foody_owner;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO foody_owner;
GRANT ALL ON SCHEMA pgmq TO foody_owner;
GRANT ALL ON ALL TABLES IN SCHEMA pgmq TO foody_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgmq TO foody_owner;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgmq TO foody_owner;
\connect postgres
CREATE DATABASE sight_rehearsal OWNER sight_owner;
REVOKE CONNECT, TEMPORARY ON DATABASE sight_rehearsal FROM PUBLIC;
GRANT CONNECT ON DATABASE sight_rehearsal TO sight_owner, ocd_backup;
\connect sight
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%') THEN RAISE EXCEPTION 'Bootstrap requires empty new database'; END IF; END $$;
CREATE EXTENSION IF NOT EXISTS pgmq;
GRANT ALL ON SCHEMA public TO sight_owner;
GRANT ALL ON ALL TABLES IN SCHEMA public TO sight_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO sight_owner;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO sight_owner;
GRANT ALL ON SCHEMA pgmq TO sight_owner;
GRANT ALL ON ALL TABLES IN SCHEMA pgmq TO sight_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgmq TO sight_owner;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgmq TO sight_owner;
\connect postgres
\connect sight_rehearsal
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%') THEN RAISE EXCEPTION 'Bootstrap requires empty new database'; END IF; END $$;
CREATE EXTENSION IF NOT EXISTS pgmq;
GRANT ALL ON SCHEMA public TO sight_owner;
GRANT ALL ON ALL TABLES IN SCHEMA public TO sight_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO sight_owner;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO sight_owner;
GRANT ALL ON SCHEMA pgmq TO sight_owner;
GRANT ALL ON ALL TABLES IN SCHEMA pgmq TO sight_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgmq TO sight_owner;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgmq TO sight_owner;
\connect postgres
CREATE DATABASE skyline_rehearsal OWNER skyline_owner;
REVOKE CONNECT, TEMPORARY ON DATABASE skyline_rehearsal FROM PUBLIC;
GRANT CONNECT ON DATABASE skyline_rehearsal TO skyline_owner, ocd_backup;
\connect skyline
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%') THEN RAISE EXCEPTION 'Bootstrap requires empty new database'; END IF; END $$;
CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT ALL ON SCHEMA public TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL TABLES IN SCHEMA public TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON SCHEMA pgmq TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL TABLES IN SCHEMA pgmq TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgmq TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgmq TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON SCHEMA topology TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL TABLES IN SCHEMA topology TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL SEQUENCES IN SCHEMA topology TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA topology TO skyline_owner WITH GRANT OPTION;
\connect postgres
\connect skyline_rehearsal
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%') THEN RAISE EXCEPTION 'Bootstrap requires empty new database'; END IF; END $$;
CREATE EXTENSION IF NOT EXISTS pgmq;
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT ALL ON SCHEMA public TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL TABLES IN SCHEMA public TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON SCHEMA pgmq TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL TABLES IN SCHEMA pgmq TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgmq TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgmq TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON SCHEMA topology TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL TABLES IN SCHEMA topology TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL SEQUENCES IN SCHEMA topology TO skyline_owner WITH GRANT OPTION;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA topology TO skyline_owner WITH GRANT OPTION;
\connect postgres
CREATE DATABASE sight_docs_rehearsal OWNER sight_docs_owner;
REVOKE CONNECT, TEMPORARY ON DATABASE sight_docs_rehearsal FROM PUBLIC;
GRANT CONNECT ON DATABASE sight_docs_rehearsal TO sight_docs_owner, ocd_backup;
\connect sight_docs
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%') THEN RAISE EXCEPTION 'Bootstrap requires empty new database'; END IF; END $$;
GRANT ALL ON SCHEMA public TO sight_docs_owner;
GRANT ALL ON ALL TABLES IN SCHEMA public TO sight_docs_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO sight_docs_owner;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO sight_docs_owner;
\connect postgres
\connect sight_docs_rehearsal
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%') THEN RAISE EXCEPTION 'Bootstrap requires empty new database'; END IF; END $$;
GRANT ALL ON SCHEMA public TO sight_docs_owner;
GRANT ALL ON ALL TABLES IN SCHEMA public TO sight_docs_owner;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO sight_docs_owner;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO sight_docs_owner;
\connect postgres
