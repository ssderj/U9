import { getDb } from './idb.js';
import { scheduleSync } from './syncEngine.js';

// Same public shape as the original single-file app's `storage` object (get/set/delete/list),
// so the existing ~16,000 lines of component code can eventually keep calling this exactly as
// they do today — see README.md's migration note. The only behavioral addition: every set/
// delete also records the change in an outbox and asks the sync engine to push it, so the app
// keeps working identically offline and just picks up sync for free once signed in.

export const storage = {
  async get(key) {
    const db = await getDb();
    const value = await db.get('kv', key);
    return value === undefined ? null : { key, value };
  },

  // L3: kv + outbox + the versions read all happen in ONE IndexedDB transaction. Before, they were
  // three separate awaits: a crash/tab-kill between the kv write and the outbox write left an edit
  // saved locally but never queued for sync, and a sync landing between the versions read and the
  // outbox write could stamp the entry with a stale baseVersion. A transaction commits all of it
  // or none of it. Nothing non-IndexedDB may be awaited inside it (the transaction would auto-commit
  // early) — scheduleSync() runs only after tx.done.
  async set(key, value) {
    const db = await getDb();
    const tx = db.transaction(['kv', 'outbox', 'versions'], 'readwrite');
    tx.done.catch(() => { /* surfaced through the awaits below; avoids an unhandled rejection */ });
    try {
      // baseVersion is the server kv_store.version this key was at the last time this device
      // synced it (0 if it's never been synced at all) -- what syncEngine.js's pushOutbox compares
      // against the row's *current* remote version to tell a real conflict (another device pushed
      // in the meantime) from a normal push, without relying on comparing wall-clock timestamps
      // between devices. See idb.js's 'versions' store and syncEngine.js for the full picture.
      const baseVersion = (await tx.objectStore('versions').get(key)) || 0;
      tx.objectStore('kv').put(value, key);
      tx.objectStore('outbox').put({ value, deleted: false, baseVersion }, key);
      await tx.done;
    } catch (e) {
      try { tx.abort(); } catch (abortErr) { /* already finished */ }
      throw e;
    }
    scheduleSync();
    return { key, value };
  },

  async delete(key) {
    const db = await getDb();
    const tx = db.transaction(['kv', 'outbox', 'versions'], 'readwrite');
    tx.done.catch(() => {});
    try {
      const baseVersion = (await tx.objectStore('versions').get(key)) || 0;
      tx.objectStore('kv').delete(key);
      tx.objectStore('outbox').put({ value: null, deleted: true, baseVersion }, key);
      await tx.done;
    } catch (e) {
      try { tx.abort(); } catch (abortErr) { /* already finished */ }
      throw e;
    }
    scheduleSync();
  },

  async list(prefix) {
    const db = await getDb();
    const allKeys = await db.getAllKeys('kv');
    return prefix ? allKeys.filter((k) => k.startsWith(prefix)) : allKeys;
  },
};
