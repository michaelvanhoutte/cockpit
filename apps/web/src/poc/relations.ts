import { readPoc, relationsKey, updatePoc, writePoc, type Relations } from './store';

/** POC (throwaway): the parent → children relation, the one thing about an Item kept in the browser. */

export function childrenOf(relations: Relations, itemId: string): string[] {
  return relations[itemId] ?? [];
}

export function parentsOf(relations: Relations, itemId: string): string[] {
  return Object.entries(relations)
    .filter(([, children]) => children.includes(itemId))
    .map(([parent]) => parent);
}

export function addChildren(workspaceId: string, parentId: string, childIds: string[]): void {
  updatePoc<Relations>(relationsKey(workspaceId), {}, (was) => ({
    ...was,
    [parentId]: [...new Set([...(was[parentId] ?? []), ...childIds.filter((id) => id !== parentId)])],
  }));
}

export function dropParent(workspaceId: string, parentId: string): void {
  const was = readPoc<Relations>(relationsKey(workspaceId), {});
  const next = { ...was };
  delete next[parentId];
  writePoc(relationsKey(workspaceId), next);
}

export const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
