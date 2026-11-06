import { describe, expect, it } from "vitest";

import { loadLabConfig, validateLabConfig } from "./config";

describe("loadLabConfig", () => {
  it("loads checksummed current deployment defaults", () => {
    const config = loadLabConfig({});

    expect(config.chainId).toBe(11155111);
    expect(config.pool).toBe("0x30530991e296a663a32567C170b290fB88578408");
    expect(config.adapter).toBe("0x6c180a345F6eA433AfE59c35c2a611B0d15d1c09");
  });

  it("rejects invalid address overrides", () => {
    expect(() => loadLabConfig({ VITE_MORPHO_ADDRESS: "bad" })).toThrow(
      "Morpho address",
    );
  });

  it("rejects a config for the wrong chain", () => {
    expect(() => {
      validateLabConfig({ ...loadLabConfig({}), chainId: 1 });
    }).toThrow("11155111");
  });
});
