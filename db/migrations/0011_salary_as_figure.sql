-- Step 12: the fixed salary is only a figure to compare with what staff were really paid.
-- The statement keeps counting the real payments (the اجوره lines), so the salary lines
-- that version 0.11 wrote into the expenses by itself are taken out again.
UPDATE expenses e SET deleted_at = now(), updated_at = now()
FROM salary_accruals a
WHERE a.expense_id = e.id AND e.deleted_at IS NULL;

UPDATE salary_accruals SET expense_id = NULL WHERE expense_id IS NOT NULL;
