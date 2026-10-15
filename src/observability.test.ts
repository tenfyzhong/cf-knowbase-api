import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { unstable_readConfig } from "wrangler";

describe("Worker observability configuration", () => {
  it("disables invocation logs while preserving custom logs", () => {
    const config = unstable_readConfig({
      config: fileURLToPath(new URL("../wrangler.toml", import.meta.url)),
    });

    // OAuth query parameters must not be captured in automatic invocation logs.
    expect(config.observability?.logs?.invocation_logs).toBe(false);
    expect(config.observability?.logs?.enabled).toBe(true);
  });
});
