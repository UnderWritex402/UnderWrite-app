import { describe, expect, it } from "vitest";
import {
  buildCliArgs,
  configurationGroups,
  nextMenuIndex,
  parseTuiCommand,
  renderWelcome,
} from "../src/tui.js";

describe("Xwrite command surface", () => {
  it("parses Gemini-style slash commands and aliases", () => {
    expect(parseTuiCommand("/verify")).toBe("verify");
    expect(parseTuiCommand("status")).toBe("status");
    expect(parseTuiCommand("/?")).toBe("help");
    expect(parseTuiCommand("/exit")).toBe("quit");
    expect(parseTuiCommand("/unknown")).toBe("unknown");
  });

  it("renders the Xwrite wordmark, hints, and context footer", () => {
    const welcome = renderWelcome("UnderWrite-app");
    expect(welcome).toContain("██╗  ██╗");
    expect(welcome).toContain("Xwrite — UnderWrite verification agent");
    expect(welcome).toContain("/verify");
    expect(welcome).toContain("UnderWrite-app  ·  stellar-testnet");
  });
});

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
