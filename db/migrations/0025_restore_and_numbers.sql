-- Step 25 (v1.0): restoring a backup on a computer that shares the server, bill numbers and
-- member numbers that never repeat, and the "who did what" log that a restore keeps.

------------------------------------------------------------------------
-- Bill numbers
------------------------------------------------------------------------
-- The counter is kept on each computer and is not in the shared data. After a restore it
-- went back to the backup's value while the bills typed after the backup came back from
-- the server, so the next number was one that already existed and every new bill failed.
-- Now a number that is already taken moves the counter past the highest one of that
-- computer and year.
CREATE OR REPLACE FUNCTION next_receipt_no(p_device UUID, p_year INT) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_no INT; v_prefix TEXT; v_head TEXT; v_top INT;
BEGIN
    SELECT receipt_prefix INTO v_prefix FROM devices WHERE id = p_device;
    IF v_prefix IS NULL THEN RAISE EXCEPTION 'unknown device %', p_device; END IF;
    v_head := v_prefix || '-' || p_year || '-';
    INSERT INTO receipt_counters AS c (device_id, solar_year, last_no) VALUES (p_device, p_year, 1)
    ON CONFLICT (device_id, solar_year) DO UPDATE SET last_no = c.last_no + 1
    RETURNING last_no INTO v_no;
    IF EXISTS (SELECT 1 FROM receipts WHERE receipt_no = v_head || lpad(v_no::TEXT, 6, '0')) THEN
        SELECT max(substr(receipt_no, length(v_head) + 1)::INT) INTO v_top FROM receipts
        WHERE left(receipt_no, length(v_head)) = v_head AND substr(receipt_no, length(v_head) + 1) ~ '^[0-9]{1,9}$';
        v_no := GREATEST(v_no, COALESCE(v_top, 0) + 1);
        UPDATE receipt_counters SET last_no = v_no WHERE device_id = p_device AND solar_year = p_year;
    END IF;
    RETURN v_head || lpad(v_no::TEXT, 6, '0');
END $$;

------------------------------------------------------------------------
-- Member numbers
------------------------------------------------------------------------
-- The next number is one past the highest number held (a removed member whose number was
-- freed holds none), stepping over numbers the fingerprint device has for someone not in
-- the app and other computers' ranges. A freed number in the middle is not suggested: the
-- partners see the empty numbers and can type one in by hand.
CREATE OR REPLACE FUNCTION next_member_no() RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    WITH me AS (
        SELECT COALESCE(d.member_no_from, 1) AS lo, COALESCE(d.member_no_to, 2147483647) AS hi,
               d.member_no_from IS NULL AS free
        FROM (SELECT current_device() AS id) c LEFT JOIN devices d ON d.id = c.id
    ), others AS (
        SELECT member_no_from AS lo, member_no_to AS hi FROM devices
        WHERE member_no_from IS NOT NULL AND id IS DISTINCT FROM current_device()
    ), start AS (
        SELECT COALESCE(max(m.member_no), me.lo - 1) + 1 AS first FROM me
        LEFT JOIN members m ON m.member_no BETWEEN me.lo AND me.hi AND m.no_freed_at IS NULL
             AND NOT (me.free AND EXISTS (SELECT 1 FROM others o WHERE m.member_no BETWEEN o.lo AND o.hi))
        GROUP BY me.lo
    )
    SELECT min(n)::INT FROM me, start s, generate_series(s.first, LEAST(me.hi::BIGINT, s.first + 100000)) n
    WHERE NOT EXISTS (SELECT 1 FROM k50_device_ids k WHERE k.no = n)
      AND NOT (me.free AND EXISTS (SELECT 1 FROM others o WHERE n BETWEEN o.lo AND o.hi))
$$;

------------------------------------------------------------------------
-- Sync helpers
------------------------------------------------------------------------
CREATE FUNCTION sync_pk_cols(t TEXT) RETURNS TEXT[]
LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT array_agg(a.attname::TEXT ORDER BY array_position(i.indkey::INT2[], a.attnum))
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = to_regclass('public.' || quote_ident(t)) AND i.indisprimary
$$;

-- This computer's rows as they are now, as changes to send: the whole row ('U'), or a
-- delete ('D') when the row is not here. `keys` is [{"tbl": .., "pk": {..}}].
CREATE FUNCTION sync_local_rows(keys JSONB, who UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
    k   JSONB;
    t   TEXT;
    pkc TEXT[];
    r   JSONB;
    out JSONB[] := '{}';
BEGIN
    FOR k IN SELECT x FROM jsonb_array_elements(keys) x LOOP
        t := k ->> 'tbl';
        pkc := sync_pk_cols(t);
        CONTINUE WHEN pkc IS NULL OR NOT (k -> 'pk') ?& pkc;
        EXECUTE format('SELECT to_jsonb(t) FROM %I t WHERE (%s) = (SELECT %s FROM jsonb_populate_record(NULL::%I, $1) x)',
                       t, (SELECT string_agg(format('t.%I', c), ', ') FROM unnest(pkc) c),
                       (SELECT string_agg(format('x.%I', c), ', ') FROM unnest(pkc) c), t)
        INTO r USING k -> 'pk';
        out := array_append(out, jsonb_build_object('tbl', t, 'pk', k -> 'pk', 'op', CASE WHEN r IS NULL THEN 'D' ELSE 'U' END,
                                                    'row', r, 'user_id', who, 'origin', current_device()));
    END LOOP;
    RETURN to_jsonb(out);
END $$;

-- On the hub: rows sent by a computer that restored a backup (or found changes the hub never
-- took), applied as the new truth and numbered like every other change, so every computer
-- takes them. A row whose parent comes later in the same restore waits for it; the caller
-- sends everything in one transaction, in batches, and says which batch is the last.
-- Returns the hub's last number.
CREATE FUNCTION sync_rewind(entries JSONB, final BOOLEAN) RETURNS BIGINT
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    w        RECORD;
    progress BOOLEAN;
BEGIN
    IF sync_mode() <> 'hub' THEN RAISE EXCEPTION 'sync_not_hub'; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('pezhohesh.sync_hub'));
    PERFORM set_config('pezhohesh.applying', 'on', true);
    CREATE TEMP TABLE IF NOT EXISTS pz_rewind_wait (n BIGSERIAL PRIMARY KEY, e JSONB NOT NULL) ON COMMIT DROP;
    INSERT INTO pz_rewind_wait (e) SELECT x FROM jsonb_array_elements(entries) x;
    LOOP
        progress := false;
        FOR w IN SELECT * FROM pz_rewind_wait ORDER BY n LOOP
            BEGIN
                PERFORM sync_apply_entry(w.e);
                INSERT INTO sync_log (hub_seq, origin, tbl, pk, op, row, user_id)
                VALUES (nextval('sync_hub_seq'), (w.e ->> 'origin')::UUID, w.e ->> 'tbl', w.e -> 'pk', w.e ->> 'op',
                        w.e -> 'row', (w.e ->> 'user_id')::UUID);
                DELETE FROM pz_rewind_wait WHERE n = w.n;
                progress := true;
            EXCEPTION
                WHEN foreign_key_violation OR unique_violation THEN NULL;  -- try again after the others
                WHEN OTHERS THEN
                    INSERT INTO sync_problems (entry, error) VALUES (w.e, 'rewind ' || SQLSTATE || ' ' || SQLERRM);
                    DELETE FROM pz_rewind_wait WHERE n = w.n;
            END;
        END LOOP;
        EXIT WHEN NOT progress;
    END LOOP;
    IF final THEN
        INSERT INTO sync_problems (entry, error) SELECT e, 'rewind: still blocked by another row' FROM pz_rewind_wait;
        DELETE FROM pz_rewind_wait;
    END IF;
    PERFORM set_config('pezhohesh.applying', 'off', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.device_id', '', true);
    RETURN (SELECT max(hub_seq) FROM sync_log WHERE hub_seq > 0);
END $$;

-- On the hub: the older states of a row are dropped after `days` days; the newest state of
-- every row stays, so every computer can still catch up and a restore still knows what
-- changed after it. Returns how many were dropped.
CREATE FUNCTION sync_prune(days INT) RETURNS BIGINT
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n BIGINT;
BEGIN
    IF sync_mode() <> 'hub' THEN RETURN 0; END IF;
    DELETE FROM sync_log l
    WHERE l.made_at < now() - make_interval(days => days) AND l.hub_seq > 0
      AND EXISTS (SELECT 1 FROM sync_log x WHERE x.tbl = l.tbl AND x.pk = l.pk AND x.hub_seq > l.hub_seq);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

------------------------------------------------------------------------
-- Restore: what stays as it is now
------------------------------------------------------------------------
-- Just before a restore replaces the database, the API copies into the schema pz_keep what
-- must survive it: the whole "who did what" log, the user accounts, the computers, the bill
-- counters, this computer's own settings and the fingerprint device's lists. Each table is
-- kept as one JSON column `j` (so nothing in it depends on the schema being replaced).
-- Right after, with the restored database brought up to this version, this puts them back
-- and writes the restore itself into the log. pz_keep.info has who restored which file.
CREATE FUNCTION pz_upsert_from(src TEXT, dst TEXT, per_row BOOLEAN, keep_existing BOOLEAN DEFAULT false) RETURNS VOID
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    cols TEXT[];
    pkc  TEXT[] := sync_pk_cols(dst);
    sets TEXT;
    sql  TEXT;
    r    RECORD;
BEGIN
    IF to_regclass(src) IS NULL OR to_regclass('public.' || quote_ident(dst)) IS NULL THEN RETURN; END IF;
    SELECT array_agg(a.attname::TEXT ORDER BY a.attnum) INTO cols
    FROM pg_attribute a
    WHERE a.attrelid = to_regclass('public.' || quote_ident(dst)) AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';
    SELECT string_agg(format('%I = EXCLUDED.%I', c, c), ', ') INTO sets FROM unnest(cols) c WHERE NOT c = ANY (pkc);
    sql := format('INSERT INTO %I (%s) SELECT %s FROM (SELECT jsonb_populate_record(NULL::%I, s.j) AS x FROM %s s %%s) q ON CONFLICT (%s) DO %s',
                  dst,
                  (SELECT string_agg(format('%I', c), ', ') FROM unnest(cols) c),
                  (SELECT string_agg(format('(q.x).%I', c), ', ') FROM unnest(cols) c), dst, src,
                  (SELECT string_agg(format('%I', c), ', ') FROM unnest(pkc) c),
                  CASE WHEN sets IS NULL OR keep_existing THEN 'NOTHING' ELSE 'UPDATE SET ' || sets END);
    IF NOT per_row THEN
        EXECUTE format(sql, '');
        RETURN;
    END IF;
    -- One by one, so a row that no longer fits (its member was not in the backup) is skipped.
    FOR r IN EXECUTE format('SELECT ctid AS c FROM %s', src) LOOP
        BEGIN
            EXECUTE format(sql, 'WHERE s.ctid = $1') USING r.c;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
    END LOOP;
END $$;

CREATE FUNCTION restore_merge_kept() RETURNS TEXT
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    who  UUID;
    what JSONB;
    mode TEXT;
BEGIN
    IF to_regnamespace('pz_keep') IS NULL THEN RETURN NULL; END IF;
    SELECT (j ->> 'user_id')::UUID, j INTO who, what FROM pz_keep.info;
    -- Nothing of this goes to the server as a change of its own.
    PERFORM set_config('pezhohesh.applying', 'on', true);

    PERFORM pz_upsert_from('pz_keep.devices', 'devices', true);
    -- A person's staff row (a manager added after the backup) comes back with their account.
    PERFORM pz_upsert_from('pz_keep.staff', 'staff', true, true);
    PERFORM pz_upsert_from('pz_keep.app_users', 'app_users', true);
    INSERT INTO receipt_counters AS c (device_id, solar_year, last_no)
    SELECT (k.j ->> 'device_id')::UUID, (k.j ->> 'solar_year')::INT, (k.j ->> 'last_no')::INT FROM pz_keep.receipt_counters k
    WHERE EXISTS (SELECT 1 FROM devices d WHERE d.id = (k.j ->> 'device_id')::UUID)
    ON CONFLICT (device_id, solar_year) DO UPDATE SET last_no = GREATEST(c.last_no, EXCLUDED.last_no);

    -- This computer's own settings and the users' permissions, as they are now. The point
    -- the restored data had reached on the server (sync_pulled) is the backup's.
    INSERT INTO settings (key, value, updated_at)
    SELECT k.j ->> 'key', k.j -> 'value', (k.j ->> 'updated_at')::TIMESTAMPTZ FROM pz_keep.settings k
    WHERE (sync_local_setting(k.j ->> 'key') OR k.j ->> 'key' = 'role_access') AND k.j ->> 'key' <> 'sync_pulled'
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;
    DELETE FROM settings s WHERE sync_local_setting(s.key) AND s.key <> 'sync_pulled'
      AND NOT EXISTS (SELECT 1 FROM pz_keep.settings k WHERE k.j ->> 'key' = s.key);

    -- The fingerprint device was not restored: its lists stay as they are now.
    DELETE FROM k50_device_ids;
    PERFORM pz_upsert_from('pz_keep.k50_device_ids', 'k50_device_ids', false);
    PERFORM pz_upsert_from('pz_keep.k50_fingers', 'k50_fingers', false);
    PERFORM pz_upsert_from('pz_keep.k50_users', 'k50_users', true);
    PERFORM pz_upsert_from('pz_keep.k50_name_ok', 'k50_name_ok', true);

    -- On a computer that shares the server, the restored data becomes everyone's: the
    -- rows changed after the backup are sent as they are now (see sync.rs, rewind). Numbers
    -- of changes written from now on are past every number this computer used before.
    mode := COALESCE((SELECT value #>> '{}' FROM settings WHERE key = 'sync_mode'), 'off');
    IF mode = 'node' THEN
        INSERT INTO settings (key, value)
        VALUES ('sync_rewind', to_jsonb(COALESCE((SELECT (value #>> '{}')::BIGINT FROM settings WHERE key = 'sync_pulled'), 0)))
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
    ELSE
        DELETE FROM settings WHERE key IN ('sync_pulled', 'sync_rewind');
    END IF;
    PERFORM setval(pg_get_serial_sequence('sync_log', 'seq'),
                   GREATEST(COALESCE((SELECT max(seq) FROM sync_log), 0), (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT));

    -- The whole log as it was before the restore, then the restore itself.
    DELETE FROM audit_log;
    INSERT INTO audit_log (id, at, user_id, device_id, table_name, row_id, action, before, after)
    SELECT (a.x).id, (a.x).at,
           CASE WHEN EXISTS (SELECT 1 FROM app_users u WHERE u.id = (a.x).user_id) THEN (a.x).user_id END,
           CASE WHEN EXISTS (SELECT 1 FROM devices d WHERE d.id = (a.x).device_id) THEN (a.x).device_id END,
           (a.x).table_name, (a.x).row_id, (a.x).action, (a.x).before, (a.x).after
    FROM (SELECT jsonb_populate_record(NULL::audit_log, k.j) AS x FROM pz_keep.audit_log k) a;
    PERFORM setval(pg_get_serial_sequence('audit_log', 'id'), GREATEST(COALESCE((SELECT max(id) FROM audit_log), 0), 1));
    PERFORM set_config('pezhohesh.applying', 'off', true);
    INSERT INTO audit_log (user_id, device_id, table_name, row_id, action, before, after)
    VALUES (CASE WHEN EXISTS (SELECT 1 FROM app_users u WHERE u.id = who) THEN who END,
            (SELECT d.id FROM devices d WHERE d.id = current_device()),
            'backup', gen_random_uuid(), 'restore', NULL, what - 'user_id');

    DROP SCHEMA pz_keep CASCADE;
    RETURN what ->> 'file';
END $$;
