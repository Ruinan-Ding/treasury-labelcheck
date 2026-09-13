/**
 * Keeps the workspace in this browser's IndexedDB so a refresh does not throw away a
 * half-reviewed batch. IndexedDB rather than localStorage because it stores the label
 * image files themselves. Nothing here leaves the device; Reset workspace empties it.
 */

// Bump when a saved shape changes, so a stale record from an earlier deploy is ignored
// instead of reaching the comparison rules with fields they no longer expect.
const WORKSPACE_VERSION = 1;

const STORE = "workspace";
let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("labelcheck", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    // Resolved on commit, not on the request: a quota failure surfaces as an abort.
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

export async function loadWorkspace<T extends { version: number }>(key: string): Promise<T | undefined> {
  const saved = await run<T | undefined>("readonly", (store) => store.get(key));
  return saved?.version === WORKSPACE_VERSION ? saved : undefined;
}

export function saveWorkspace(key: string, value: object): Promise<IDBValidKey> {
  return run("readwrite", (store) => store.put({ ...value, version: WORKSPACE_VERSION }, key));
}

export function clearWorkspace(): Promise<undefined> {
  return run("readwrite", (store) => store.clear());
}
