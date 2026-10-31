/** A schema file in the real one's shape, small enough to read at a glance; a test overrides what it is about. */

export const column = (name, extra = {}) => ({ name, type: 'TEXT', required: false, default: null, primaryKey: null, references: null, queriedAs: name.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), ...extra });

export const schema = (overrides = {}) => ({
  databases: [
    {
      key: 'register',
      name: 'Register',
      kind: 'D1',
      oneFor: 'every account',
      definedIn: ['apps/api/migrations/', 'apps/api/src/db/schema.ts'],
      tables: [
        { name: 'tenants', strict: false, queriedAs: 'tenants', columns: [column('id', { required: true, primaryKey: 1 })], indexes: [] },
        {
          name: 'old_items',
          strict: false,
          queriedAs: null,
          columns: [column('id', { primaryKey: 1, queriedAs: null }), column('tenant_id', { queriedAs: null, references: { table: 'tenants', column: 'id', onDelete: 'NO ACTION' } })],
          indexes: [],
        },
      ],
    },
    {
      key: 'account-store',
      name: 'Account store',
      kind: 'Durable Object',
      oneFor: 'each account',
      definedIn: ['apps/api/src/accounts/changes.ts', 'apps/api/src/accounts/schema.ts'],
      tables: [
        { name: 'workspaces', strict: true, queriedAs: 'workspaces', columns: [column('id', { required: true, primaryKey: 1 })], indexes: [] },
        {
          name: 'items',
          strict: true,
          queriedAs: 'items',
          columns: [
            column('id', { required: true, primaryKey: 1 }),
            column('workspace_id', { required: true, references: { table: 'workspaces', column: 'id', onDelete: 'RESTRICT' } }),
            column('status', { required: true, noLongerUsed: 'Written on every insert, read nowhere.' }),
            column('forgotten_at'),
          ],
          indexes: [
            { name: 'items_workspace_status', unique: false, columns: ['workspace_id', 'status'] },
            { name: 'items_live_id', unique: true, columns: ['id'], where: 'deleted_at IS NULL' },
          ],
        },
        { name: 'retired_rules', strict: true, queriedAs: 'retiredRules', noLongerUsed: 'Nothing reads it.', columns: [column('rules')], indexes: [] },
        { name: 'hidden_things', strict: true, queriedAs: 'hiddenThings', columns: [column('hidden_at')], indexes: [] },
      ],
    },
  ],
  ...overrides,
});

/** The file as the generator is handed it. */
export const schemaFile = (overrides) => ({ file: 'apps/api/database-schema.json', text: JSON.stringify(schema(overrides)) });

/**
 * Source files naming what the schema above uses: every table and column but
 * `forgotten_at` and `hidden_things`, which no code names, and what is written down as no longer used.
 */
export const codeNaming = [
  { path: 'apps/api/src/accounts', package: false, role: 'core', files: [
    { file: 'apps/api/src/accounts/repo.ts', text: 'select(items).where(eq(items.workspaceId, workspaces.id)); tenants.id; status' },
    { file: 'apps/api/src/accounts/schema.ts', text: 'forgottenAt hidden_things hiddenAt' },
  ] },
];
