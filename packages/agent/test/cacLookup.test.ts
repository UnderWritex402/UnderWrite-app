import { describe, expect, it } from "vitest";
import { fetchCacLookup, namesMatch } from "../src/sources/cacLookup.js";
import type { CacLookupConfig } from "../src/config.js";
import type { VerificationRequest } from "../src/types.js";

function config(
  provider: CacLookupConfig["CAC_LOOKUP_PROVIDER"],
): CacLookupConfig {
  return {
    CAC_LOOKUP_PROVIDER: provider,
    CAC_LOOKUP_BASE_URL: "https://api.example/",
    CAC_LOOKUP_API_KEY: "test-key",
  };
}

function request(rcNumber: string | null = "RC123456"): VerificationRequest {
  return {
    invoiceId: "inv-1",
    document: new Uint8Array([1]),
    documentFilename: "invoice.pdf",
    amountMinor: 500_000_00n,
    currency: "NGN",
    invoiceDate: "2026-01-05",
    dueDate: "2026-03-05",
    buyer: { address: "GBUYER", name: "Zenith Foods Ltd.", rcNumber },
    seller: { address: "GSELLER", name: "Kanem Logistics", rcNumber: "RC999" },
  };
}

describe("namesMatch", () => {
  it("ignores legal form, case and punctuation", () => {
    expect(namesMatch("Zenith Foods Ltd.", "ZENITH FOODS LIMITED")).toBe(true);
    expect(namesMatch("Kanem Logistics Nigeria Plc", "Kanem Logistics")).toBe(
      true,
    );
  });

  it("catches a genuinely different distinctive name", () => {
    expect(namesMatch("Zenith Foods Ltd", "Zenith Farms Limited")).toBe(false);
  });
});

describe("fetchCacLookup", () => {
  it("maps a Dojah response onto the common shape", async () => {
    const result = await fetchCacLookup(request(), config("dojah"), "buyer", {
      request: async (url) => {
        expect(url).toContain("rc_number=RC123456");
        return {
          entity: {
            company_name: "ZENITH FOODS LIMITED",
            company_status: "ACTIVE",
            date_of_registration: "2015-04-01",
          },
        };
      },
    });

    if (result.status !== "ok") throw new Error(result.reason);
    expect(result.result.registered).toBe(true);
    expect(result.result.registeredName).toBe("ZENITH FOODS LIMITED");
    expect(result.result.status).toBe("ACTIVE");
    expect(result.result.registrationDate).toBe("2015-04-01");
    expect(result.result.nameMismatch).toBe(false);
    expect(result.result.provider).toBe("dojah");
  });

  it("maps a Mono response onto the same shape", async () => {
    const result = await fetchCacLookup(request(), config("mono"), "buyer", {
      request: async () => ({
        data: {
          name: "ZENITH FOODS LIMITED",
          status: "ACTIVE",
          date_of_registration: "2015-04-01",
        },
      }),
    });
    if (result.status !== "ok") throw new Error(result.reason);
    expect(result.result.registeredName).toBe("ZENITH FOODS LIMITED");
    expect(result.result.provider).toBe("mono");
  });

  it("maps a Zeeh response onto the same shape", async () => {
    const result = await fetchCacLookup(request(), config("zeeh"), "buyer", {
      request: async () => ({
        data: {
          companyName: "ZENITH FOODS LIMITED",
          companyStatus: "ACTIVE",
          registrationDate: "2015-04-01",
        },
      }),
    });
    if (result.status !== "ok") throw new Error(result.reason);
    expect(result.result.registeredName).toBe("ZENITH FOODS LIMITED");
  });

  it("flags a name mismatch against the registry", async () => {
    const result = await fetchCacLookup(request(), config("dojah"), "buyer", {
      request: async () => ({
        entity: { company_name: "ZENITH FARMS LIMITED", company_status: "ACTIVE" },
      }),
    });
    if (result.status !== "ok") throw new Error(result.reason);
    expect(result.result.nameMismatch).toBe(true);
  });

  it("treats an empty envelope as not registered, not as a clean check", async () => {
    const result = await fetchCacLookup(request(), config("dojah"), "buyer", {
      request: async () => ({ entity: {} }),
    });
    if (result.status !== "ok") throw new Error(result.reason);
    expect(result.result.registered).toBe(false);
    expect(result.result.registeredName).toBeNull();
  });

  it("is unavailable when the party supplied no RC number", async () => {
    const result = await fetchCacLookup(request(null), config("dojah"), "buyer", {
      request: async () => {
        throw new Error("should not be called");
      },
    });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.reason).toContain("no CAC registration number");
  });

  it("is unavailable when the provider errors", async () => {
    const result = await fetchCacLookup(request(), config("dojah"), "buyer", {
      request: async () => {
        throw new Error("502 bad gateway");
      },
    });
    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.reason).toContain("502 bad gateway");
  });

  it("can be pointed at the seller instead of the buyer", async () => {
    const result = await fetchCacLookup(request(), config("dojah"), "seller", {
      request: async (url) => {
        expect(url).toContain("RC999");
        return { entity: { company_name: "KANEM LOGISTICS LIMITED" } };
      },
    });
    expect(result.status).toBe("ok");
  });
});
