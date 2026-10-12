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
  const resources = new WeakMap<Session, Resource>();

  function get(session: Session) {
    const existing = resources.get(session);
    if (existing) return existing;

    const resource = createResource(session);
    resources.set(session, resource);
    return resource;
  }

  async function grantPermit(session: Session, contracts: Address[]) {
    await get(session).permits.grantPermit(contracts);
  }

  async function clear(session: Session) {
    const resource = resources.get(session);
    if (!resource) return;

    try {
      await resource.permits.clear();
    } finally {
      resource.terminate();
      resources.delete(session);
    }
  }

  return { get, grantPermit, clear };
}
