import { describe, expect, it } from "vitest";
import {
  buildCliArgs,
  configurationGroups,
  nextMenuIndex,
} from "../src/tui.js";

describe("nextMenuIndex", () => {
  it("wraps in both directions", () => {
    expect(nextMenuIndex(0, "up", 4)).toBe(3);
    expect(nextMenuIndex(3, "down", 4)).toBe(0);
  });
});

describe("buildCliArgs", () => {
  it("builds a controlled testnet dry run", () => {
    expect(
      buildCliArgs({
        requestPath: "/tmp/request.json",
        paymentMode: "skip",
        orderId: null,
        submit: false,
      }),
    ).toEqual(["--request", "/tmp/request.json", "--skip-payment"]);
  });

  it("builds a paid submission and rejects a missing order", () => {
    expect(
      buildCliArgs({
        requestPath: "/tmp/request.json",
        paymentMode: "order",
        orderId: " ord_123 ",
        submit: true,
      }),
    ).toEqual([
      "--request",
      "/tmp/request.json",
      "--order-id",
      "ord_123",
      "--submit",
    ]);
    expect(() =>
      buildCliArgs({
        requestPath: "/tmp/request.json",
        paymentMode: "order",
        orderId: null,
        submit: false,
      }),
    ).toThrow(/order id/);
  });
});

describe("configurationGroups", () => {
  it("reports presence without retaining secret values", () => {
    const groups = configurationGroups({
      AGENT_EVM_PRIVATE_KEY: "super-secret-value",
      AGENT_ID: "underwrite_v1",
    });
    expect(groups[0]?.items).toEqual([
      { name: "AGENT_EVM_PRIVATE_KEY", configured: true },
      { name: "AGENT_ID", configured: true },
    ]);
    expect(JSON.stringify(groups)).not.toContain("super-secret-value");
  });
});
