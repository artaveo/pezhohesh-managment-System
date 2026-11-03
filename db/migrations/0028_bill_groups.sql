-- Several months paid at once: one period and one bill per month, so each month's money
-- counts in its own month (as the Excel book's month columns do) and each month can be
-- changed on its own. The bills of one payment share bill_group and print as one paper.
ALTER TABLE receipts ADD COLUMN bill_group UUID;
CREATE INDEX receipts_bill_group_idx ON receipts (bill_group) WHERE bill_group IS NOT NULL;
