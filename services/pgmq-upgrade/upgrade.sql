\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '5min';
CREATE TEMP TABLE queue_counts (relation text PRIMARY KEY, rows bigint);
DO $$
DECLARE item record; relation_name text; row_count bigint;
BEGIN
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='pgmq' ORDER BY tablename LOOP
    relation_name := format('pgmq.%I', item.tablename);
    EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', relation_name);
    EXECUTE format('SELECT count(*) FROM %s', relation_name) INTO row_count;
    INSERT INTO queue_counts VALUES (relation_name, row_count);
  END LOOP;
END $$;
ALTER EXTENSION pgmq UPDATE TO '1.12.0';
DO $$
DECLARE item record; actual bigint;
BEGIN
  FOR item IN SELECT * FROM queue_counts LOOP
    EXECUTE format('SELECT count(*) FROM %s', item.relation) INTO actual;
    IF actual <> item.rows THEN RAISE EXCEPTION 'Queue row count changed: %', item.relation; END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_depend d ON d.objid=c.oid AND d.classid='pg_class'::regclass AND d.deptype='e'
    JOIN pg_extension e ON e.oid=d.refobjid
    WHERE n.nspname='pgmq' AND c.relkind IN ('r','p')
      AND NOT (c.oid = ANY(COALESCE(e.extconfig, '{}'::oid[])))
  ) THEN RAISE EXCEPTION 'PGMQ still contains tables excluded from normal backups'; END IF;
END $$;
SELECT extversion FROM pg_extension WHERE extname='pgmq';
SELECT count(*) AS verified_queue_tables FROM queue_counts;
COMMIT;
