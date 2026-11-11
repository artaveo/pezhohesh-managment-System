-- «یادداشت‌ها» are the partners' own: the manager's database role loses the table too
-- (the API already refuses everyone but a partner).
REVOKE ALL ON notes FROM pz_manager;
