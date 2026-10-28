-- Sync, step 1: the groundwork for several computers sharing one set of data through the
-- central database in Neon (the "hub").
--
-- Every change to a shared table is written down in sync_log by a trigger, as the whole
-- row after the change. On an offline computer (a "node") those rows are its outbox: it
-- sends them to the hub when it has internet, and the hub gives each one a number
-- (hub_seq) in the order it arrived. Every computer then asks the hub for the rows after
-- the last number it has seen and applies them with sync_apply. Computers that are always
-- online use the hub directly, and their changes go into the hub's sync_log as they happen.
--
-- Nothing changes until settings.sync_mode is set: with no sync_mode nothing is written
-- down, so the app works exactly as before.

-- Each computer can get its own range of member numbers, so two computers that are both
-- offline never give the same number to two people. A computer with no range takes the
-- next number outside every other computer's range (today's behaviour).
ALTER TABLE devices
    ADD COLUMN member_no_from INT,
    ADD COLUMN member_no_to   INT,
    ADD CONSTRAINT devices_member_range CHECK (
        (member_no_from IS NULL AND member_no_to IS NULL)
        OR (member_no_from > 0 AND member_no_to >= member_no_from));

-- The computer making the change: the API names it per connection (app.device_id) when it
-- shares a database with others; otherwise it is the one in settings.
CREATE FUNCTION current_device() RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE(nullif(current_setting('app.device_id', true), '')::UUID,
                    (SELECT (value #>> '{}')::UUID FROM settings WHERE key = 'this_device_id'))
$$;

-- The next free member number for this computer. It also skips numbers already used on
-- the fingerprint device (k50_device_ids) by people who are not in the app.
CREATE FUNCTION next_member_no() RETURNS INT
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
        LEFT JOIN members m ON m.member_no BETWEEN me.lo AND me.hi
             AND NOT (me.free AND EXISTS (SELECT 1 FROM others o WHERE m.member_no BETWEEN o.lo AND o.hi))
        GROUP BY me.lo
    )
    SELECT min(n)::INT FROM me, start s, generate_series(s.first, LEAST(me.hi::BIGINT, s.first + 100000)) n
    WHERE NOT EXISTS (SELECT 1 FROM k50_device_ids k WHERE k.no = n)
      AND NOT (me.free AND EXISTS (SELECT 1 FROM others o WHERE n BETWEEN o.lo AND o.hi))
$$;
GRANT EXECUTE ON FUNCTION current_device(), next_member_no() TO pz_partner, pz_manager, pz_pec;

CREATE TABLE sync_log (
    seq        BIGSERIAL PRIMARY KEY,
    hub_seq    BIGINT,              -- the hub's number; NULL on a node = not sent yet, on the hub = refused
    origin     UUID,                -- the computer that made the change
    origin_seq BIGINT,              -- its seq there (only for rows that came from a node)
    tbl        TEXT NOT NULL,
    pk         JSONB NOT NULL,      -- the primary key, e.g. {"id": "..."}
    op         CHAR(1) NOT NULL CHECK (op IN ('I', 'U', 'D')),
    row        JSONB,               -- the whole row after the change (NULL for D)
    user_id    UUID,
    made_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (origin, origin_seq)
);
CREATE UNIQUE INDEX sync_log_hub_seq ON sync_log (hub_seq) WHERE hub_seq > 0;
CREATE INDEX sync_log_outbox ON sync_log (seq) WHERE hub_seq IS NULL;
CREATE INDEX sync_log_row ON sync_log (tbl, pk);
CREATE SEQUENCE sync_hub_seq;

-- Changes that could not be applied here (or that the hub refused), for the partners to see.
CREATE TABLE sync_problems (
    id          BIGSERIAL PRIMARY KEY,
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    entry       JSONB NOT NULL,
    error       TEXT NOT NULL,
    resolved_at TIMESTAMPTZ
);
GRANT SELECT ON sync_problems TO pz_partner;

-- 'off' (or missing), 'node' or 'hub'. Kept per computer: it is never sent.
CREATE FUNCTION sync_mode() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT COALESCE((SELECT value #>> '{}' FROM settings WHERE key = 'sync_mode'), 'off')
$$;

-- True while sync_apply / sync_push are writing rows that came from another computer.
CREATE FUNCTION sync_applying() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(current_setting('pezhohesh.applying', true), '') = 'on'
$$;

-- Settings that belong to one computer and are never sent.
CREATE FUNCTION sync_local_setting(k TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT k = 'this_device_id' OR k LIKE 'k50%' OR k LIKE 'backup\_%' OR k LIKE 'online\_%'
        OR k LIKE 'sync\_%'
$$;

-- The trigger on every shared table. Its arguments are the primary key columns.
CREATE FUNCTION sync_capture() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    mode TEXT;
    r    JSONB := to_jsonb(COALESCE(NEW, OLD));
    k    JSONB := '{}';
    col  TEXT;
BEGIN
    IF sync_applying() THEN RETURN NULL; END IF;
    mode := sync_mode();
    IF mode NOT IN ('node', 'hub') THEN RETURN NULL; END IF;
    IF TG_TABLE_NAME = 'settings' AND sync_local_setting(r ->> 'key') THEN RETURN NULL; END IF;
    FOREACH col IN ARRAY TG_ARGV LOOP
        k := k || jsonb_build_object(col, r -> col);
    END LOOP;
    -- A changed key is a delete of the old row and an insert of the new one.
    IF TG_OP = 'UPDATE' THEN
        DECLARE old_k JSONB := '{}'; o JSONB := to_jsonb(OLD);
        BEGIN
            FOREACH col IN ARRAY TG_ARGV LOOP
                old_k := old_k || jsonb_build_object(col, o -> col);
            END LOOP;
            IF old_k <> k THEN
                PERFORM sync_write(mode, TG_TABLE_NAME, old_k, 'D', NULL);
            END IF;
        END;
    END IF;
    PERFORM sync_write(mode, TG_TABLE_NAME, k,
                       CASE TG_OP WHEN 'INSERT' THEN 'I' WHEN 'UPDATE' THEN 'U' ELSE 'D' END,
                       CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
    RETURN NULL;
END $$;

-- On the hub every change gets its number at once, under a lock held until commit, so the
-- numbers are in commit order and a computer reading "everything after N" never skips one.
CREATE FUNCTION sync_write(mode TEXT, t TEXT, k JSONB, o CHAR, r JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n BIGINT;
BEGIN
    IF mode = 'hub' THEN
        PERFORM pg_advisory_xact_lock(hashtext('pezhohesh.sync_hub'));
        n := nextval('sync_hub_seq');
    END IF;
    INSERT INTO sync_log (hub_seq, origin, tbl, pk, op, row, user_id)
    VALUES (n, current_device(), t, k, o, r, nullif(current_setting('app.user_id', true), '')::UUID);
END $$;

-- Apply one change from another computer. The caller has set pezhohesh.applying.
CREATE FUNCTION sync_apply_entry(e JSONB) RETURNS VOID
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    t     TEXT := e ->> 'tbl';
    r     JSONB := e -> 'row';
    pkc   TEXT[];
    cols  TEXT[];
    sets  TEXT;
BEGIN
    SELECT array_agg(a.attname::TEXT ORDER BY array_position(i.indkey::INT2[], a.attnum)) INTO pkc
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
    WHERE i.indrelid = to_regclass('public.' || quote_ident(t)) AND i.indisprimary;
    IF pkc IS NULL THEN RAISE EXCEPTION 'sync_unknown_table %', t; END IF;
    IF NOT (e -> 'pk') ?& pkc THEN RAISE EXCEPTION 'sync_bad_key'; END IF;

    PERFORM set_config('app.user_id', COALESCE(e ->> 'user_id', ''), true);
    PERFORM set_config('app.device_id', COALESCE(e ->> 'origin', ''), true);

    IF e ->> 'op' = 'D' THEN
        EXECUTE format('DELETE FROM %I t WHERE (%s) = (SELECT %s FROM jsonb_populate_record(NULL::%I, $1) x)',
                       t, (SELECT string_agg(format('t.%I', c), ', ') FROM unnest(pkc) c),
                       (SELECT string_agg(format('x.%I', c), ', ') FROM unnest(pkc) c), t)
        USING e -> 'pk';
        RETURN;
    END IF;

    -- Only the columns both sides have; sync refuses to run between different app versions,
    -- so in practice that is all of them.
    SELECT array_agg(a.attname::TEXT ORDER BY a.attnum) INTO cols
    FROM pg_attribute a
    WHERE a.attrelid = to_regclass('public.' || quote_ident(t)) AND a.attnum > 0
      AND NOT a.attisdropped AND a.attgenerated = '' AND r ? a.attname;
    SELECT string_agg(format('%I = EXCLUDED.%I', c, c), ', ') INTO sets
    FROM unnest(cols) c WHERE NOT c = ANY (pkc);

    EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM jsonb_populate_record(NULL::%I, $1) ON CONFLICT (%s) DO %s',
                   t,
                   (SELECT string_agg(format('%I', c), ', ') FROM unnest(cols) c),
                   (SELECT string_agg(format('%I', c), ', ') FROM unnest(cols) c),
                   t,
                   (SELECT string_agg(format('%I', c), ', ') FROM unnest(pkc) c),
                   CASE WHEN sets IS NULL THEN 'NOTHING' ELSE 'UPDATE SET ' || sets END)
    USING r;
END $$;

-- A node applies what it pulled from the hub, oldest first, and returns the last hub_seq
-- it handled. A row this computer changed again since (not yet sent, or sent later than
-- this entry) is left as it is here: the hub will take this computer's version.
-- One bad entry does not stop the rest; it goes to sync_problems.
CREATE FUNCTION sync_apply(entries JSONB) RETURNS BIGINT
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    e    JSONB;
    me   UUID := current_device();
    last BIGINT;
BEGIN
    PERFORM set_config('pezhohesh.applying', 'on', true);
    FOR e IN SELECT x FROM jsonb_array_elements(entries) x ORDER BY (x ->> 'hub_seq')::BIGINT LOOP
        last := (e ->> 'hub_seq')::BIGINT;
        -- This computer's own change, already here. (After a restore from an older backup
        -- it may not be: then it is taken back from the hub like any other.)
        CONTINUE WHEN (e ->> 'origin')::UUID IS NOT DISTINCT FROM me
                  AND EXISTS (SELECT 1 FROM sync_log l WHERE l.hub_seq = last AND l.origin = me);
        CONTINUE WHEN EXISTS (SELECT 1 FROM sync_log l
                              WHERE l.tbl = e ->> 'tbl' AND l.pk = e -> 'pk' AND l.origin IS NOT DISTINCT FROM me
                                AND (l.hub_seq IS NULL OR l.hub_seq > last));
        BEGIN
            PERFORM sync_apply_entry(e);
        EXCEPTION WHEN OTHERS THEN
            INSERT INTO sync_problems (entry, error) VALUES (e, SQLSTATE || ' ' || SQLERRM);
        END;
    END LOOP;
    PERFORM set_config('pezhohesh.applying', 'off', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.device_id', '', true);
    RETURN last;
END $$;

-- On the hub: take a node's outbox. Each entry is applied and logged with the next hub_seq;
-- one it already has (same origin and origin_seq) is not applied twice. Returns
-- [{"origin_seq": n, "hub_seq": m}], where m = 0 means the hub could not apply it.
CREATE FUNCTION sync_push(entries JSONB) RETURNS JSONB
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    e    JSONB;
    n    BIGINT;
    done JSONB := '[]';
BEGIN
    IF sync_mode() <> 'hub' THEN RAISE EXCEPTION 'sync_not_hub'; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('pezhohesh.sync_hub'));
    PERFORM set_config('pezhohesh.applying', 'on', true);
    FOR e IN SELECT x FROM jsonb_array_elements(entries) x ORDER BY (x ->> 'seq')::BIGINT LOOP
        SELECT COALESCE(hub_seq, 0) INTO n FROM sync_log
        WHERE origin = (e ->> 'origin')::UUID AND origin_seq = (e ->> 'seq')::BIGINT;
        IF NOT FOUND THEN
            BEGIN
                PERFORM sync_apply_entry(e);
                n := nextval('sync_hub_seq');
            EXCEPTION WHEN OTHERS THEN
                n := NULL;
                INSERT INTO sync_problems (entry, error) VALUES (e, SQLSTATE || ' ' || SQLERRM);
            END;
            INSERT INTO sync_log (hub_seq, origin, origin_seq, tbl, pk, op, row, user_id, made_at)
            VALUES (n, (e ->> 'origin')::UUID, (e ->> 'seq')::BIGINT, e ->> 'tbl', e -> 'pk', e ->> 'op',
                    e -> 'row', (e ->> 'user_id')::UUID, (e ->> 'made_at')::TIMESTAMPTZ);
            n := COALESCE(n, 0);
        END IF;
        done := done || jsonb_build_object('origin_seq', (e ->> 'seq')::BIGINT, 'hub_seq', n);
    END LOOP;
    PERFORM set_config('pezhohesh.applying', 'off', true);
    PERFORM set_config('app.user_id', '', true);
    PERFORM set_config('app.device_id', '', true);
    RETURN done;
END $$;

-- Rows that come from another computer arrive exactly as they were there: their
-- updated_at, their end date, their cascade (which arrives as its own rows).
-- The audit log names the computer too, also when the API did not set app.device_id.
CREATE OR REPLACE FUNCTION write_audit() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user UUID := nullif(current_setting('app.user_id', true), '')::UUID;
        v_dev  UUID := current_device();
BEGIN
    INSERT INTO audit_log (user_id, device_id, table_name, row_id, action, before, after)
    VALUES (v_user, v_dev, TG_TABLE_NAME,
            COALESCE(NEW.id, OLD.id), lower(TG_OP),
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT sync_applying() THEN NEW.updated_at := now(); END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION members_before_remove() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF sync_applying() THEN RETURN NEW; END IF;
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM book_loans WHERE member_id = NEW.id AND returned_on IS NULL AND deleted_at IS NULL)
           OR EXISTS (SELECT 1 FROM loan_deposits WHERE member_id = NEW.id AND returned_on IS NULL AND deleted_at IS NULL) THEN
            RAISE EXCEPTION 'member_has_open_loans';
        END IF;
        NEW.delete_batch := COALESCE(NEW.delete_batch, gen_random_uuid());
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
        NEW.delete_batch := NULL;
        NEW.deleted_reason := NULL;
    END IF;
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION members_cascade() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF sync_applying() THEN RETURN NULL; END IF;
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        UPDATE memberships SET deleted_at = NEW.deleted_at, delete_batch = NEW.delete_batch, deleted_reason = NEW.deleted_reason
            WHERE member_id = NEW.id AND deleted_at IS NULL;
        UPDATE member_documents SET deleted_at = NEW.deleted_at, delete_batch = NEW.delete_batch
            WHERE member_id = NEW.id AND deleted_at IS NULL;
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND OLD.delete_batch IS NOT NULL THEN
        UPDATE memberships SET deleted_at = NULL, delete_batch = NULL, deleted_reason = NULL
            WHERE member_id = NEW.id AND delete_batch = OLD.delete_batch;
        UPDATE member_documents SET deleted_at = NULL, delete_batch = NULL
            WHERE member_id = NEW.id AND delete_batch = OLD.delete_batch;
    END IF;
    RETURN NULL;
END $$;

-- The shared tables. Kept on each computer only: logins and sessions, the fingerprint
-- device's own lists and finger templates, bill counters (each computer numbers its own
-- bills), the phone inbox, the audit log (each computer writes its own, also for changes
-- that arrive), and sync's own tables.
DO $$
DECLARE t RECORD;
BEGIN
    FOR t IN SELECT * FROM (VALUES
        ('app_users', 'id'), ('attendance', 'id'), ('book_loans', 'id'), ('books', 'id'),
        ('devices', 'id'), ('expense_categories', 'id'), ('expenses', 'id'),
        ('hotspot_buys', 'id'), ('hotspot_cards', 'volume_gb'), ('hotspot_purchases', 'id'),
        ('hotspot_sales', 'id'), ('import_batches', 'id'), ('loan_deposits', 'id'),
        ('member_documents', 'id'), ('members', 'id'), ('memberships', 'id'),
        ('month_summaries', 'id'), ('partner_shares', 'id'), ('pec_clients', 'id'),
        ('pec_contracts', 'id'), ('pec_services', 'id'), ('plans', 'id'), ('receipts', 'id'),
        ('salary_accruals', 'id'), ('settings', 'key'), ('staff', 'id'), ('withdrawals', 'id')
    ) v(tbl, pk) LOOP
        EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION sync_capture(%L)',
                       t.tbl || '_sync', t.tbl, t.pk);
    END LOOP;
END $$;
