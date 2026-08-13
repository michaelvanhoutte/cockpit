/**
 * Single user today, SaaS-ready tomorrow (architecture driver #4): every row
 * is tenant-scoped from the first migration, but until app login (§8.1) lands
 * there is exactly one tenant, resolved here. When auth arrives, this becomes
 * a lookup on the session instead of a constant, and nothing else changes.
 */
export const DEFAULT_TENANT_ID = 'tenant-default';
