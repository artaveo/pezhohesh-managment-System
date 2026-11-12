-- The two monthly plans by who they are for, not by their price (the price is shown next to
-- the name anyway): 300 is for new members, 250 is the old members' fee. Only plans still
-- under their first names; one a partner renamed on «قیمت‌ها» stays as it is. Bills keep the
-- words they were printed with.
UPDATE plans SET name = 'عضویت ماهانه (جدید)' WHERE name = 'عضویت ماهانه 300' AND kind = 'monthly';
UPDATE plans SET name = 'عضویت ماهانه' WHERE name = 'عضویت ماهانه 250' AND kind = 'monthly';
