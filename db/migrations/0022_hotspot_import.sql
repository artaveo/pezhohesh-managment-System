-- The Excel book's hotspot sheet (انترنت هاتسپات) is imported too: its supplier bills, its
-- daily counts of cards sold, and so the cards in hand. Importing the year again replaces
-- the rows of the earlier run, as for receipts and expenses.
ALTER TABLE hotspot_buys ADD COLUMN import_batch_id UUID REFERENCES import_batches(id);
ALTER TABLE hotspot_purchases ADD COLUMN import_batch_id UUID REFERENCES import_batches(id);
ALTER TABLE hotspot_sales ADD COLUMN import_batch_id UUID REFERENCES import_batches(id);
CREATE INDEX hotspot_buys_batch_idx ON hotspot_buys (import_batch_id);
CREATE INDEX hotspot_sales_batch_idx ON hotspot_sales (import_batch_id);
