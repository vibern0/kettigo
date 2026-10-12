import type { EIP712TypedData } from "@zama-fhe/sdk";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;
const READ_SESSION_STORAGE_PREFIX = "kettigo.zama-read-session.v1";

type BrowserStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type ZamaReadSessionKey = {
  privateKey: Hex;
  address: Address;
  expiresAtMs: number;
};

function readSessionStorageKey(safeAddress: string) {
  return `${READ_SESSION_STORAGE_PREFIX}:${safeAddress.toLowerCase()}`;
}

function isStoredReadSessionKey(value: unknown): value is ZamaReadSessionKey {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<ZamaReadSessionKey>;
  return typeof record.privateKey === "string"
    && /^0x[0-9a-fA-F]{64}$/.test(record.privateKey)
    && typeof record.address === "string"
    && /^0x[0-9a-fA-F]{40}$/.test(record.address)
    && typeof record.expiresAtMs === "number"
    && Number.isFinite(record.expiresAtMs);
}

export function getOrCreateZamaReadSessionKey(
  storage: BrowserStorage,
  safeAddress: string,
  nowMs: number,
  dependencies: {
    generatePrivateKey(): Hex;
    getAccountAddress(privateKey: Hex): Address;
  },
): ZamaReadSessionKey {
  const storageKey = readSessionStorageKey(safeAddress);
  const serialized = storage.getItem(storageKey);
  if (serialized !== null) {
    try {
      const stored: unknown = JSON.parse(serialized);
      if (isStoredReadSessionKey(stored) && stored.expiresAtMs > nowMs) {
        return stored;
      }
    } catch {
      // Replace malformed browser state below.
    }
  }

  const privateKey = dependencies.generatePrivateKey();
  const created = {
    privateKey,
    address: dependencies.getAccountAddress(privateKey),
    expiresAtMs: nowMs + SEVEN_DAYS_IN_SECONDS * 1_000,
  };
  storage.setItem(storageKey, JSON.stringify(created));
  return created;
}

export function removeZamaReadSessionKey(storage: BrowserStorage, safeAddress: string) {
  storage.removeItem(readSessionStorageKey(safeAddress));
}

export function signZamaReadSessionTypedData(
  privateKey: Hex,
  typedData: EIP712TypedData,
) {
  const { EIP712Domain: _, ...types } = typedData.types;
  return privateKeyToAccount(privateKey).signTypedData({
    domain: typedData.domain as any,
    primaryType: typedData.primaryType as string,
    types: types as any,
    message: typedData.message as any,
  });
}

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
      })
      .catch((error) => {
        clearPromises.delete(session);
        throw error;
      });
    clearPromises.set(session, clearing);
    return clearing;
  }

  return { run, grantPermit, clear };
}

export function createDelegatedZamaSessionManager<
  Session extends object,
  SessionKey,
  Resource extends ZamaSessionResource,
>({
  createSessionKey,
  createResource,
  ensureDelegated,
}: {
  createSessionKey(session: Session): Promise<SessionKey>;
  createResource(key: SessionKey): Resource;
  ensureDelegated(session: Session, key: SessionKey, contracts: Address[]): Promise<void>;
}) {
  type Entry = {
    key: SessionKey;
    resource: Resource;
    tail: Promise<void>;
  };

  const entries = new WeakMap<Session, Promise<Entry>>();
  const closedSessions = new WeakSet<Session>();

  function getOrCreate(session: Session) {
    const existing = entries.get(session);
    if (existing) return existing;

    const created = createSessionKey(session).then((key) => ({
      key,
      resource: createResource(key),
      tail: Promise.resolve(),
    }));
    entries.set(session, created);
    return created;
  }

  async function run<Result>(
    session: Session,
    contracts: Address[],
    operation: (resource: Resource, key: SessionKey) => Promise<Result>,
  ) {
    if (closedSessions.has(session)) {
      throw new Error("Zama session is closed.");
    }

    const entry = await getOrCreate(session);
    const result = entry.tail.then(async () => {
      await ensureDelegated(session, entry.key, contracts);
      return operation(entry.resource, entry.key);
    });
    entry.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function clear(session: Session) {
    closedSessions.add(session);
    const existing = entries.get(session);
    if (!existing) return;

    const entry = await existing;
    await entry.tail;
    try {
      await entry.resource.permits.clear();
    } finally {
      entry.resource.terminate();
      entries.delete(session);
    }
  }

  return { run, clear };
}
