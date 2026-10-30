-- The queue: repairs a tech took and hasn't finished, rush first, then by drop-off time. Columns
-- are added rather than the table rebuilt, so offers can keep pointing at it (see 0002).

ALTER TABLE requests ADD COLUMN rush INTEGER NOT NULL DEFAULT 0; -- the rush fee in dollars, 0 for none
ALTER TABLE requests ADD COLUMN done INTEGER; -- epoch ms the tech marked it done; null until then

-- Requests filed with a rush before this ran have it only in their intake.
UPDATE requests SET rush = COALESCE(json_extract(intake, '$.rush'), 0);
