-- The Excel import writes one line in «چه کسی چه کرد» for the whole run (its rows are bulk
-- work that write_audit skips). The app's roles may not write audit_log themselves (0002), so
-- the line goes through this function, which runs as its owner like write_audit does. Before
-- this, every import in the app from 1.2.5 on failed with "permission denied for table audit_log".
CREATE FUNCTION audit_import(batch UUID) RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    INSERT INTO audit_log (user_id, table_name, row_id, action, after)
    SELECT nullif(current_setting('app.user_id', true), '')::uuid, 'import_batches', b.id, 'import', b.summary
    FROM import_batches b WHERE b.id = batch;
$$;
REVOKE ALL ON FUNCTION audit_import(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_import(UUID) TO pz_partner, pz_manager;
