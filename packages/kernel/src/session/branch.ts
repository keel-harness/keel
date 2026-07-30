import { SessionStore, readSession } from "./store.js";

/**
 * Fork a session at event index `atIndex`: copy the first `atIndex` post-header events
 * of the source into a NEW session whose header records the parent lineage
 * (`{ id, atIndex }`). The source ledger is never mutated, so the two logs diverge while
 * sharing an identical prefix. Returns the new session id.
 */
export function branch(id: string, atIndex: number, env: NodeJS.ProcessEnv = process.env): string {
  const source = readSession(id, env);
  if (!Number.isSafeInteger(atIndex) || atIndex < 0) {
    throw new RangeError("session branch index must be a nonnegative safe integer");
  }
  if (atIndex > source.events.length) {
    throw new RangeError(
      `session ${id} branch index ${atIndex} is out of range; expected 0..${source.events.length}`,
    );
  }
  const prefix = source.events.slice(0, atIndex);
  const store = SessionStore.create({ cwd: source.meta.cwd, parent: { id, atIndex } }, env);
  try {
    for (const ev of prefix) store.append(ev);
  } finally {
    store.close(); // always release the fd, even if a prefix write fails
  }
  return store.id;
}
