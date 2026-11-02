-- The repeat check on every valid post looks for the same form filed in the last few minutes.
-- Indexing created lets it read only those few rows instead of the whole table. intake is left
-- out: it's the whole form as JSON, so indexing it would copy every request, and the rows from
-- the last few minutes are already few enough to compare.
CREATE INDEX IF NOT EXISTS requests_by_created ON requests (created);
