-- Expand-only: adds an index, changes no row. A pull request's page and the CSV
-- export read the request rows of one branch, which nothing indexed until now.
CREATE INDEX usage_requests_branch ON usage_requests (branch);
