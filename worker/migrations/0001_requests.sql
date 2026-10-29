-- Requests from the form, and the offer of each one to each tech. Applied by the deploy job
-- (`wrangler d1 migrations apply`); add changes as new numbered files, never edit this one.

CREATE TABLE requests (
	id TEXT PRIMARY KEY,
	created INTEGER NOT NULL, -- epoch ms
	intake TEXT NOT NULL, -- the parsed form, as JSON
	slot_start INTEGER, -- epoch ms; both null when no time was picked
	slot_end INTEGER,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'declined')),
	confirmed_by TEXT -- the offer token of the tech who took it
);

-- The tech's details are copied in, so a change to TECHS doesn't break a request in flight.
CREATE TABLE offers (
	token TEXT PRIMARY KEY, -- random; the tech's link is /offers/<token>
	request_id TEXT NOT NULL REFERENCES requests (id),
	position INTEGER NOT NULL, -- order in TECHS
	name TEXT NOT NULL,
	email TEXT NOT NULL,
	calendar_id TEXT NOT NULL,
	hold_id TEXT, -- their tentative event, if they were free at the time and still hold it
	declined INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX offers_by_request ON offers (request_id, position);
