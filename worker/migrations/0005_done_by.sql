-- Any tech can mark a repair done now, not only the one who approved the drop-off, so who did is
-- kept too. Added rather than the table rebuilt, so offers can keep pointing at it (see 0002), and
-- the code still live when this runs never reads it. Repairs marked done before this have none:
-- only the approver could mark them.
ALTER TABLE requests ADD COLUMN done_by TEXT; -- the offer token of the tech who marked it done
