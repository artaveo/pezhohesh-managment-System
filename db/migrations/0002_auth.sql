-- Step 2: sign-in, sessions and per-role access.
--
-- The API connects with one database login and, for every request, switches to the
-- signed-in person's role inside the transaction (SET LOCAL ROLE pz_partner / pz_manager / pz_pec).
-- The grants and row-level policies below then decide what that request can see or change,
-- so a mistake in the API cannot show hall money to education staff or vice versa.

------------------------------------------------------------------------
-- 1. Sign-in state (not audited: it changes on every login)
------------------------------------------------------------------------

ALTER TABLE app_users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE login_state (
    user_id       UUID PRIMARY KEY REFERENCES app_users(id),
    failed_logins INT NOT NULL DEFAULT 0,
    locked_until  TIMESTAMPTZ,
    last_login_at TIMESTAMPTZ
);

CREATE TABLE user_sessions (                     -- only a SHA-256 of the token is stored
    token_hash    BYTEA PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES app_users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,          -- slides forward while the app is in use
    revoked_at    TIMESTAMPTZ
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

------------------------------------------------------------------------
-- 2. Database roles, one per app role
------------------------------------------------------------------------

DO $$
DECLARE r TEXT;
BEGIN
    FOREACH r IN ARRAY ARRAY['pz_partner', 'pz_manager', 'pz_pec'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('CREATE ROLE %I NOLOGIN', r);
        END IF;
        -- the API's own login must be allowed to switch into each role (needed on Neon)
        EXECUTE format('GRANT %I TO %I', r, current_user);
    END LOOP;
END $$;

-- Audit rows and bill numbers are written on behalf of every role, without giving
-- anyone direct access to audit_log or receipt_counters.
ALTER FUNCTION write_audit() SECURITY DEFINER SET search_path = public;
ALTER FUNCTION next_receipt_no(UUID, INT) SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION next_receipt_no(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION next_receipt_no(UUID, INT) TO pz_partner, pz_manager, pz_pec;

GRANT USAGE ON SCHEMA public TO pz_partner, pz_manager, pz_pec;

-- Partners: everything except the sign-in internals. Rows are soft-deleted, but partners
-- may hard-delete (for example a duplicate imported by mistake).
GRANT SELECT, INSERT, UPDATE, DELETE ON
    devices, staff, app_users, partner_shares, settings,
    members, member_documents, plans, memberships, attendance, fingerprint_sync_queue,
    books, book_loans, loan_deposits, hotspot_purchases, hotspot_sales,
    pec_clients, pec_services, pec_contracts,
    receipts, expense_categories, expenses, salary_accruals, withdrawals
TO pz_partner;
GRANT SELECT ON audit_log, login_state TO pz_partner;

-- Manager: all study-hall work and accounting, partner shares read-only,
-- no user accounts, no settings changes, no education records.
GRANT SELECT, INSERT, UPDATE ON
    members, member_documents, plans, memberships, attendance, fingerprint_sync_queue,
    books, book_loans, loan_deposits, hotspot_purchases, hotspot_sales,
    receipts, expense_categories, expenses, salary_accruals, withdrawals
TO pz_manager;
GRANT SELECT ON devices, staff, partner_shares, settings TO pz_manager;
GRANT SELECT (id, staff_id, username, role, active) ON app_users TO pz_manager;

-- Education staff: education records and their own bills and expenses only.
GRANT SELECT, INSERT, UPDATE ON pec_clients, pec_services, pec_contracts,
    receipts, expense_categories, expenses TO pz_pec;
GRANT SELECT ON devices, settings TO pz_pec;
GRANT SELECT (id, full_name, title, department, active) ON staff TO pz_pec;
GRANT SELECT (id, staff_id, username, role, active) ON app_users TO pz_pec;

------------------------------------------------------------------------
-- 3. Row-level security on the tables both departments share
------------------------------------------------------------------------

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['receipts', 'expense_categories', 'expenses', 'withdrawals'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY partner_all ON %I TO pz_partner USING (true) WITH CHECK (true)', t);
        EXECUTE format($p$CREATE POLICY manager_hall ON %I TO pz_manager
                          USING (department = 'hall') WITH CHECK (department = 'hall')$p$, t);
        EXECUTE format($p$CREATE POLICY pec_own ON %I TO pz_pec
                          USING (department = 'pec') WITH CHECK (department = 'pec')$p$, t);
    END LOOP;
END $$;
