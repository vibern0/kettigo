import type { Address } from "viem";

const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;

type ZamaSessionResource = {
  permits: {
    grantPermit(contracts: Address[]): Promise<void>;
    clear(): Promise<void>;
  };
  terminate(): void;
};

export function createPersistentCredentialOptions<Storage>(storage: Storage) {
  return {
    storage,
    permitTTL: 7,
    transportKeyPairTTL: SEVEN_DAYS_IN_SECONDS,
  };
}

export function createZamaSessionManager<Session extends object, Resource extends ZamaSessionResource>(
  createResource: (session: Session) => Resource,
) {
  type SessionResource = {
    resource: Resource;
    tail: Promise<void>;
  };

  const resources = new WeakMap<Session, SessionResource>();
  const closedSessions = new WeakSet<Session>();
  const clearPromises = new WeakMap<Session, Promise<void>>();

  function getOrCreate(session: Session) {
    const existing = resources.get(session);
    if (existing) return existing;

    const entry = {
      resource: createResource(session),
      tail: Promise.resolve(),
    };
    resources.set(session, entry);
    return entry;
  }

  function run<Result>(session: Session, operation: (resource: Resource) => Promise<Result>) {
    if (closedSessions.has(session)) {
      return Promise.reject(new Error("Zama session is closed."));
    }

    const entry = getOrCreate(session);
    const result = entry.tail.then(() => operation(entry.resource));
    entry.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function grantPermit(session: Session, contracts: Address[]) {
    await run(session, (resource) => resource.permits.grantPermit(contracts));
  }

  async function clear(session: Session) {
    const existingClear = clearPromises.get(session);
    if (existingClear) return existingClear;

    closedSessions.add(session);
    const entry = getOrCreate(session);

    const clearing = entry.tail
      .then(() => entry.resource.permits.clear())
      .finally(() => {
        entry.resource.terminate();
        resources.delete(session);
      });
    clearPromises.set(session, clearing);
    return clearing;
  }

  return { run, grantPermit, clear };
}
