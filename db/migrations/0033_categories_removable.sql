-- Expense lines («سطرها») can be renamed and taken away. Nothing is hard-deleted: a removed
-- line is marked, and its name is freed (the name is unique per department) so it can be
-- made again. Its expenses were moved to another line first (money.rs::delete_category).
ALTER TABLE expense_categories ADD COLUMN deleted_at TIMESTAMPTZ;
