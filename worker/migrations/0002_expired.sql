-- Requests nobody took in time: the scheduled job sets them to 'expired'. SQLite can't change a
-- CHECK, so the table is rebuilt. D1 keeps foreign keys on, and dropping a table that rows still
-- point at fails, so offers is rebuilt too, pointing at the new table; renaming that table then
-- renames the reference with it.

CREATE TABLE requests_new (
	id TEXT PRIMARY KEY,
	created INTEGER NOT NULL, -- epoch ms
	intake TEXT NOT NULL, -- the parsed form, as JSON
	slot_start INTEGER, -- epoch ms; both null when no time was picked
	slot_end INTEGER,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined', 'expired')),
	confirmed_by TEXT -- the offer token of the tech who took it
);

CREATE TABLE offers_new (
	token TEXT PRIMARY KEY, -- random; the tech's link is /offers/<token>
	request_id TEXT NOT NULL REFERENCES requests_new (id),
	position INTEGER NOT NULL, -- order in TECHS
	name TEXT NOT NULL,
	email TEXT NOT NULL,
	calendar_id TEXT NOT NULL,
	hold_id TEXT, -- their tentative event, if they were free at the time and still hold it
	declined INTEGER NOT NULL DEFAULT 0
);

INSERT INTO requests_new SELECT id, created, intake, slot_start, slot_end, status, confirmed_by FROM requests;
INSERT INTO offers_new SELECT token, request_id, position, name, email, calendar_id, hold_id, declined FROM offers;
DROP TABLE offers;
DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;
ALTER TABLE offers_new RENAME TO offers;
CREATE INDEX offers_by_request ON offers (request_id, position);
