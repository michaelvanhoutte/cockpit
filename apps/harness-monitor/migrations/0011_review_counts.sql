-- What linking reads of each pull request's session record (the block in its
-- body that /build writes): how many local review rounds it ran and how many
-- findings they reported. Expand-only: adds two columns and changes no row.
ALTER TABLE pull_request_stats ADD COLUMN local_rounds INTEGER; -- review-start marks; null when the body has no record
ALTER TABLE pull_request_stats ADD COLUMN findings INTEGER;     -- sum of the review-end counts; null unless every review carries one
