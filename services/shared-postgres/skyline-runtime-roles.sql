\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE runtime_passwords (name text, password text);
INSERT INTO runtime_passwords SELECT name, gen_random_uuid()::text || gen_random_uuid()::text
FROM unnest(ARRAY['skyline_web', 'skyline_worker', 'skyline_detector']) AS name;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM runtime_passwords LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      RAISE EXCEPTION 'Runtime role already exists; refusing credential replacement';
    END IF;
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r.name, r.password);
  END LOOP;
  CREATE ROLE skyline_backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
END $$;
COMMIT;
-- Caller must capture this result privately and store it in the encrypted OCD environment.
SELECT json_object_agg(name, password) FROM runtime_passwords;
