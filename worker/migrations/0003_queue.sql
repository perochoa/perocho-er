-- The queue: repairs a tech took and hasn't finished, rush first, then by drop-off time. Columns
-- are added rather than the table rebuilt, so offers can keep pointing at it (see 0002).

-- Every row so far was a test, and some are from before times, phones and rush were required.
-- Clearing them lets the code assume every request has all three. Offers first: they point at
-- requests. slot_start and slot_end stay nullable in the schema, since making them NOT NULL
-- needs a rebuild of both tables; the worker always sets them.
DELETE FROM offers;
DELETE FROM requests;

ALTER TABLE requests ADD COLUMN rush INTEGER NOT NULL DEFAULT 0; -- the rush fee in dollars, 0 for none
ALTER TABLE requests ADD COLUMN done INTEGER; -- epoch ms the tech marked it done; null until then
