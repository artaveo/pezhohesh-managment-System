-- Step 6: internet hotspot cards, as in the Excel hotspot sheet. Cards are bought on
-- supplier bills (counts per volume) and sold at the desk; at the end of the day the
-- desk types how many of each were sold. Like the Excel statement, the income of the
-- hotspot line is the profit: what the cards sold for minus their cost (per GB).

-- The cards on sale and their price (the Excel sheet's sale formula).
CREATE TABLE hotspot_cards (
    id            UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),   -- for the audit log
    volume_gb     NUMERIC(8,2) PRIMARY KEY,
    price         NUMERIC(14,2) NOT NULL CHECK (price >= 0),
    active        BOOLEAN NOT NULL DEFAULT true,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO hotspot_cards (volume_gb, price) VALUES
    (1, 20), (2, 40), (3, 60), (5, 100), (10, 150), (20, 250), (30, 350), (50, 550);

-- What one GB costs from the supplier (the Excel sheet: 10 افغانی).
INSERT INTO settings (key, value) VALUES ('hotspot_cost_per_gb', '10') ON CONFLICT (key) DO NOTHING;

-- One supplier bill; its cards are the hotspot_purchases rows.
CREATE TABLE hotspot_buys (
    id               UUID PRIMARY KEY,
    purchased_on     DATE NOT NULL,
    supplier_bill_no TEXT,
    bill_gb          NUMERIC(10,2),               -- the GB written on the supplier's bill, to check against the cards
    extra_cost       NUMERIC(14,2) NOT NULL DEFAULT 0,
    note             TEXT,
    created_by       UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);
ALTER TABLE hotspot_purchases ADD COLUMN buy_id UUID REFERENCES hotspot_buys(id);
CREATE INDEX hotspot_purchases_buy_idx ON hotspot_purchases (buy_id);

-- One end-of-day count is one receipt (the day's profit); its rows are the cards sold.
ALTER TABLE hotspot_sales
    ADD COLUMN unit_cost  NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN receipt_id UUID REFERENCES receipts(id),
    ADD COLUMN created_by UUID REFERENCES app_users(id);
CREATE INDEX hotspot_sales_receipt_idx ON hotspot_sales (receipt_id);
CREATE INDEX hotspot_sales_sold_idx ON hotspot_sales (sold_on);

GRANT SELECT, INSERT, UPDATE, DELETE ON hotspot_cards, hotspot_buys TO pz_partner;
GRANT SELECT ON hotspot_cards TO pz_manager;
GRANT SELECT, INSERT, UPDATE ON hotspot_buys TO pz_manager;

CREATE TRIGGER hotspot_buys_touch BEFORE UPDATE ON hotspot_buys FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER hotspot_buys_audit AFTER INSERT OR UPDATE OR DELETE ON hotspot_buys FOR EACH ROW EXECUTE FUNCTION write_audit();
CREATE TRIGGER hotspot_cards_touch BEFORE UPDATE ON hotspot_cards FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER hotspot_cards_audit AFTER INSERT OR UPDATE OR DELETE ON hotspot_cards FOR EACH ROW EXECUTE FUNCTION write_audit();

-- Cards in hand per volume: bought minus sold (sales of voided counts do not count).
CREATE VIEW v_hotspot_stock WITH (security_invoker = true) AS
SELECT c.volume_gb, c.price, c.active,
       COALESCE(b.n, 0) AS bought,
       COALESCE(s.n, 0) AS sold,
       COALESCE(b.n, 0) - COALESCE(s.n, 0) AS in_hand
FROM hotspot_cards c
LEFT JOIN (
    SELECT p.volume_gb, sum(p.quantity) AS n FROM hotspot_purchases p
    JOIN hotspot_buys h ON h.id = p.buy_id
    WHERE p.deleted_at IS NULL AND h.deleted_at IS NULL GROUP BY p.volume_gb
) b ON b.volume_gb = c.volume_gb
LEFT JOIN (
    SELECT volume_gb, sum(quantity) AS n FROM hotspot_sales WHERE deleted_at IS NULL GROUP BY volume_gb
) s ON s.volume_gb = c.volume_gb;
GRANT SELECT ON v_hotspot_stock TO pz_partner, pz_manager;
