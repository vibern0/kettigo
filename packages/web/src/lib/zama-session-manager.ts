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
  const stored = loadZamaReadSessionKey(storage, safeAddress, dependencies.getAccountAddress);
  if (stored && stored.expiresAtMs > nowMs) {
    return stored;
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

export function loadZamaReadSessionKey(
  storage: BrowserStorage,
  safeAddress: string,
  getAccountAddress: (privateKey: Hex) => Address,
) {
  const serialized = storage.getItem(readSessionStorageKey(safeAddress));
  if (serialized === null) return undefined;

  try {
    const stored: unknown = JSON.parse(serialized);
    if (!isStoredReadSessionKey(stored)) return undefined;
    return {
      ...stored,
      address: getAccountAddress(stored.privateKey),
    };
  } catch {
    return undefined;
  }
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

export function prepareZamaReadContracts(
  requestedContracts: Address[],
  allowedContracts: Address[],
) {
  const allowed = [...new Set(allowedContracts)];
  const allowedSet = new Set(allowed.map((address) => address.toLowerCase()));
  for (const contract of requestedContracts) {
    if (!allowedSet.has(contract.toLowerCase())) {
      throw new Error(`${contract} is not authorized for balance reads.`);
    }
  }
  return {
    requestedContracts: [...new Set(requestedContracts)],
    delegationContracts: allowed,
  };
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
  loadSessionKey,
  createSessionKey,
  isSessionKeyValid,
  createResource,
  ensureDelegated,
}: {
  loadSessionKey(session: Session): Promise<SessionKey | undefined>;
  createSessionKey(session: Session): Promise<SessionKey>;
  isSessionKeyValid(key: SessionKey): boolean;
  createResource(key: SessionKey): Resource;
  ensureDelegated(session: Session, key: SessionKey, contracts: Address[]): Promise<void>;
}) {
  type Entry = {
    key: SessionKey;
    resource: Resource;
  };
  type State = {
    entry?: Entry;
    tail: Promise<void>;
  };

  const states = new WeakMap<Session, State>();
  const closedSessions = new WeakSet<Session>();
  const clearPromises = new WeakMap<Session, Promise<void>>();

  function getOrCreateState(session: Session) {
    const existing = states.get(session);
    if (existing) return existing;

    const created = { tail: Promise.resolve() } as State;
    states.set(session, created);
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

    const state = getOrCreateState(session);
    const result = state.tail.then(async () => {
      if (!state.entry || !isSessionKeyValid(state.entry.key)) {
        if (state.entry) state.entry.resource.terminate();
        const key = await createSessionKey(session);
        state.entry = { key, resource: createResource(key) };
      }
      const entry = state.entry;
      await ensureDelegated(session, entry.key, contracts);
      return operation(entry.resource, entry.key);
    });
    state.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function clear(session: Session) {
    const existingClear = clearPromises.get(session);
    if (existingClear) return existingClear;

    closedSessions.add(session);
    const existingState = states.get(session);
    const clearing = (async () => {
      if (existingState) await existingState.tail;
      let entry = existingState?.entry;
      if (!entry) {
        const key = await loadSessionKey(session);
        if (!key) return;
        entry = { key, resource: createResource(key) };
      }

      try {
        await entry.resource.permits.clear();
      } finally {
        entry.resource.terminate();
        states.delete(session);
      }
    })().catch((error) => {
      clearPromises.delete(session);
      throw error;
    });
    clearPromises.set(session, clearing);
    return clearing;
  }

  return { run, clear };
}
