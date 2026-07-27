import { describe, it, expect } from "vitest";
import {
  SESSION_COOKIE_NAME,
  parseCookies,
  serializeSessionCookie,
  clearSessionCookie,
} from "../cookies.js";

// Split a Set-Cookie value ("name=v; HttpOnly; ...") into its attribute segments so we can
// assert on presence/absence without worrying about substring collisions.
const attrsOf = (setCookie: string): string[] => setCookie.split("; ");

describe("parseCookies", () => {
  it("returns an empty map when the header is absent or empty", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  it("parses a single name=value pair", () => {
    expect(parseCookies("ai_admin_session=abc123")).toEqual({ ai_admin_session: "abc123" });
  });

  it("parses multiple pairs and trims the leading space after each '; '", () => {
    expect(parseCookies("ai_admin_session=abc123; theme=dark")).toEqual({
      ai_admin_session: "abc123",
      theme: "dark",
    });
  });

  it("splits only at the first '=' so values may contain '='", () => {
    expect(parseCookies("token=b=c")).toEqual({ token: "b=c" });
  });

  it("URL-decodes the value", () => {
    expect(parseCookies("k=a%20b")).toEqual({ k: "a b" });
  });

  it("skips malformed parts with no '=' and parts with an empty name", () => {
    expect(parseCookies("a=1; garbage; =novalue; b=2")).toEqual({ a: "1", b: "2" });
  });
});

describe("serializeSessionCookie", () => {
  it("carries the URL-encoded token under the session cookie name", () => {
    const value = serializeSessionCookie("tok/en=1", 1000, false);
    expect(attrsOf(value)[0]).toBe(`${SESSION_COOKIE_NAME}=tok%2Fen%3D1`);
  });

  it("sets the security attributes and converts Max-Age from ms to whole seconds", () => {
    const attrs = attrsOf(serializeSessionCookie("t", 86_400_000, false));
    expect(attrs).toContain("HttpOnly");
    expect(attrs).toContain("SameSite=Lax");
    expect(attrs).toContain("Path=/");
    expect(attrs).toContain("Max-Age=86400");
  });

  it("floors a fractional-second Max-Age", () => {
    expect(attrsOf(serializeSessionCookie("t", 1500, false))).toContain("Max-Age=1");
  });

  it("includes Secure only when secure is true", () => {
    expect(attrsOf(serializeSessionCookie("t", 1000, true))).toContain("Secure");
    expect(attrsOf(serializeSessionCookie("t", 1000, false))).not.toContain("Secure");
  });
});

describe("clearSessionCookie", () => {
  it("expires the cookie immediately with an empty value", () => {
    const attrs = attrsOf(clearSessionCookie(false));
    expect(attrs[0]).toBe(`${SESSION_COOKIE_NAME}=`);
    expect(attrs).toContain("Max-Age=0");
    expect(attrs).toContain("Path=/");
  });

  it("mirrors the Secure flag so the browser matches and clears the right cookie", () => {
    expect(attrsOf(clearSessionCookie(true))).toContain("Secure");
    expect(attrsOf(clearSessionCookie(false))).not.toContain("Secure");
  });
});

describe("round-trip: what we Set-Cookie parses back cleanly as a Cookie header", () => {
  it("recovers the original token through encode → decode", () => {
    // The browser sends back only the "name=value" segment (no attributes), so that's what we parse.
    const nameValue = attrsOf(serializeSessionCookie("tok en/with=special", 1000, false))[0];
    expect(parseCookies(nameValue)).toEqual({ [SESSION_COOKIE_NAME]: "tok en/with=special" });
  });
});
