import { describe, it, expect } from "vitest";
import { resolveAllowOrigin } from "./worker.js";

// The connector port. Private-LAN / mDNS origins are only trusted on this port,
// because that is the only thing the desktop connector itself serves.
const P = 17777;
const env = { ALLOWED_ORIGINS: "https://tool-vision.pages.dev,capacitor://localhost" };

describe("resolveAllowOrigin", () => {
  it("echoes an explicitly configured origin", () => {
    expect(resolveAllowOrigin("https://tool-vision.pages.dev", env)).toBe("https://tool-vision.pages.dev");
    expect(resolveAllowOrigin("capacitor://localhost", env)).toBe("capacitor://localhost");
  });

  it("allows the connector-served app on localhost (the desktop station)", () => {
    // This is the regression: printing only works from the connector-served app,
    // so the AI must be reachable from it too.
    expect(resolveAllowOrigin(`http://localhost:${P}`, env)).toBe(`http://localhost:${P}`);
    expect(resolveAllowOrigin(`http://127.0.0.1:${P}`, env)).toBe(`http://127.0.0.1:${P}`);
  });

  it("allows the local dev server on any localhost port", () => {
    expect(resolveAllowOrigin("http://localhost:8080", env)).toBe("http://localhost:8080");
  });

  it("allows private-LAN and mDNS hosts on the connector port (phone relay)", () => {
    expect(resolveAllowOrigin(`http://192.168.68.113:${P}`, env)).toBe(`http://192.168.68.113:${P}`);
    expect(resolveAllowOrigin(`http://10.0.0.5:${P}`, env)).toBe(`http://10.0.0.5:${P}`);
    expect(resolveAllowOrigin(`http://zohebs-macbook-pro.local:${P}`, env)).toBe(
      `http://zohebs-macbook-pro.local:${P}`
    );
  });

  it("rejects private-LAN and mDNS hosts on any other port", () => {
    expect(resolveAllowOrigin("http://192.168.68.113:8080", env)).toBe("null");
    expect(resolveAllowOrigin("http://zohebs-macbook-pro.local:3000", env)).toBe("null");
  });

  it("rejects public hosts that merely look local", () => {
    expect(resolveAllowOrigin("https://evil.com", env)).toBe("null");
    expect(resolveAllowOrigin("http://localhost.evil.com:17777", env)).toBe("null");
    expect(resolveAllowOrigin("http://notlocalhost:17777", env)).toBe("null");
    // public IP on the connector port is still not private
    expect(resolveAllowOrigin(`http://8.8.8.8:${P}`, env)).toBe("null");
    // .local suffix on a subdomain of a public host
    expect(resolveAllowOrigin("http://evil.com.local.evil.com:17777", env)).toBe("null");
  });

  it("rejects junk and missing origins", () => {
    expect(resolveAllowOrigin("", env)).toBe("null");
    expect(resolveAllowOrigin("not a url", env)).toBe("null");
  });

  it("still allows everything when ALLOWED_ORIGINS is unset (dev escape hatch)", () => {
    expect(resolveAllowOrigin("https://anything.example", {})).toBe("*");
  });
});
