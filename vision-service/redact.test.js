import { describe, it, expect } from "vitest";
import { redact, safeDetail } from "./mcp.js";

// Anything these return can reach the model, and therefore conversation history and logs.
describe("redact", () => {
  it("strips a JWT-shaped Supabase key", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abc-DEF_123";
    expect(redact(`bad key ${jwt} rejected`)).not.toContain("eyJ");
    expect(redact(`bad key ${jwt} rejected`)).toContain("[redacted]");
  });

  it("strips a new-format Supabase secret key", () => {
    expect(redact("using sb_secret_AbCdEf0123456789xyz now")).toContain("[redacted]");
    expect(redact("using sb_secret_AbCdEf0123456789xyz now")).not.toContain("sb_secret_AbCdEf");
  });

  it("strips any other long opaque token", () => {
    const tok = "A".repeat(48);
    expect(redact(`token ${tok} denied`)).not.toContain(tok);
  });

  it("leaves an ordinary message readable", () => {
    expect(redact("duplicate key value violates unique constraint")).toBe(
      "duplicate key value violates unique constraint"
    );
  });

  it("caps runaway length", () => {
    expect(redact("x".repeat(500)).length).toBeLessThanOrEqual(160);
  });

  it("handles null and undefined without throwing", () => {
    expect(redact(undefined)).toBe("");
    expect(redact(null)).toBe("");
  });
});

describe("safeDetail", () => {
  it("keeps PostgREST's short message", () => {
    const body = JSON.stringify({ code: "23505", message: "duplicate key value", details: "Key (id)=(42) exists.", hint: null });
    expect(safeDetail(body)).toBe("duplicate key value");
  });

  it("drops details and hint, which quote row data", () => {
    const body = JSON.stringify({ message: "conflict", details: "Key (email)=(alice@example.com) exists.", hint: "try again" });
    const out = safeDetail(body);
    expect(out).not.toContain("alice@example.com");
    expect(out).not.toContain("try again");
  });

  it("never echoes a non-JSON upstream body", () => {
    expect(safeDetail("<html><body>Internal proxy error at 10.0.0.4</body></html>")).toBe("request rejected");
    expect(safeDetail("")).toBe("request rejected");
  });

  it("redacts a key that appears inside the message field", () => {
    const body = JSON.stringify({ message: "invalid token eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig-Xy_1" });
    expect(safeDetail(body)).not.toContain("eyJ");
  });
});
