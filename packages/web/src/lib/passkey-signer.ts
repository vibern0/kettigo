import type { PasskeyArgType } from "@safe-global/protocol-kit";
import { getAddress } from "viem";

import type { PasskeyMetadata } from "./passkey-metadata.ts";

export function buildPasskeySigner(
  metadata: Pick<PasskeyMetadata, "rawId" | "coordinates" | "verifierAddress">,
  rpId: string,
  dependencies: {
    getCredential(
      rawId: string,
      rpId: string,
      options?: CredentialRequestOptions,
    ): Promise<Credential>;
  },
): PasskeyArgType {
  return {
    rawId: metadata.rawId,
    coordinates: metadata.coordinates,
    verifierAddress: getAddress(metadata.verifierAddress),
    getFn: (options) => dependencies.getCredential(metadata.rawId, rpId, options),
  };
}
