type CredentialMethods = Pick<CredentialsContainer, "create" | "get">;

type WebAuthnDependencies = {
  rpId: string;
  credentials?: CredentialMethods;
};

type CreateCredentialDependencies = WebAuthnDependencies & {
  rpName: string;
  randomBytes?: (length: number) => Uint8Array<ArrayBuffer>;
};

export type PasskeyErrorKind = "cancelled" | "unsupported" | "unknown";

export function isPasskeySupported(
  navigatorLike: Pick<Navigator, "credentials"> | undefined = typeof navigator === "undefined" ? undefined : navigator,
  publicKeyCredential: typeof PublicKeyCredential | undefined =
    typeof PublicKeyCredential === "undefined" ? undefined : PublicKeyCredential,
): boolean {
  return Boolean(
    navigatorLike?.credentials &&
      typeof navigatorLike.credentials.create === "function" &&
      typeof navigatorLike.credentials.get === "function" &&
      publicKeyCredential,
  );
}

export async function createKettigoCredential(deps: CreateCredentialDependencies): Promise<Credential> {
  const credentials = deps.credentials ?? browserCredentials();
  const randomBytes = deps.randomBytes ?? secureRandomBytes;
  const accountLabel = "Kettigo account";
  const credential = await credentials.create({
    publicKey: {
      rp: { id: deps.rpId, name: deps.rpName },
      challenge: randomBytes(32),
      user: {
        id: randomBytes(32),
        name: accountLabel,
        displayName: accountLabel,
      },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      timeout: 120_000,
    },
  });

  if (!credential) throw new Error("Passkey creation was cancelled.");
  return credential;
}

export async function getKettigoCredential(
  rawId: string,
  deps: WebAuthnDependencies,
  options?: CredentialRequestOptions,
): Promise<Credential> {
  if (!/^[a-fA-F0-9]+$/.test(rawId) || rawId.length % 2 !== 0) {
    throw new Error("Invalid passkey metadata.");
  }

  const credentials = deps.credentials ?? browserCredentials();
  const credential = await credentials.get({
    ...options,
    publicKey: {
      ...options?.publicKey,
      challenge: options?.publicKey?.challenge ?? secureRandomBytes(32),
      rpId: deps.rpId,
      allowCredentials: [{ type: "public-key", id: hexToBytes(rawId) }],
      userVerification: "required",
    },
  });

  if (!credential) throw new DOMException("Passkey verification was cancelled.", "NotAllowedError");
  return credential;
}

export function classifyPasskeyError(error: unknown): PasskeyErrorKind {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "cancelled";
  const message = error instanceof Error ? error.message : String(error);
  if (/webauthn|passkey.+unavailable|not supported/i.test(message)) return "unsupported";
  return "unknown";
}

function browserCredentials(): CredentialsContainer {
  if (!isPasskeySupported()) throw new Error("WebAuthn is unavailable.");
  return navigator.credentials;
}

function secureRandomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(length));
  crypto.getRandomValues(bytes);
  return bytes;
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}
