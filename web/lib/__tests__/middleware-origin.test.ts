import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { isAllowedOrigin } from "../origin-guard.ts";

interface MiddlewareRequestStub {
  headers: Headers;
  nextUrl: URL;
}

function requestFor(url: string, headers: Record<string, string> = {}): MiddlewareRequestStub {
  return {
    headers: new Headers(headers),
    nextUrl: new URL(url),
  };
}

const ORIGINAL_ENV = {
  GSD_WEB_HOST: process.env.GSD_WEB_HOST,
  GSD_WEB_PORT: process.env.GSD_WEB_PORT,
  GSD_WEB_ALLOWED_ORIGINS: process.env.GSD_WEB_ALLOWED_ORIGINS,
};

afterEach(() => {
  if (ORIGINAL_ENV.GSD_WEB_HOST === undefined) delete process.env.GSD_WEB_HOST;
  else process.env.GSD_WEB_HOST = ORIGINAL_ENV.GSD_WEB_HOST;

  if (ORIGINAL_ENV.GSD_WEB_PORT === undefined) delete process.env.GSD_WEB_PORT;
  else process.env.GSD_WEB_PORT = ORIGINAL_ENV.GSD_WEB_PORT;

  if (ORIGINAL_ENV.GSD_WEB_ALLOWED_ORIGINS === undefined) delete process.env.GSD_WEB_ALLOWED_ORIGINS;
  else process.env.GSD_WEB_ALLOWED_ORIGINS = ORIGINAL_ENV.GSD_WEB_ALLOWED_ORIGINS;
});

describe("middleware origin validation", () => {
  test("allows configured launch origin", () => {
    process.env.GSD_WEB_HOST = "127.0.0.1";
    process.env.GSD_WEB_PORT = "4567";

    const request = requestFor("http://127.0.0.1:4567/api/boot", {
      host: "127.0.0.1:4567",
    });

    assert.equal(isAllowedOrigin(request, "http://127.0.0.1:4567"), true);
  });

  test("allows localhost alias for loopback launch", () => {
    process.env.GSD_WEB_HOST = "127.0.0.1";
    process.env.GSD_WEB_PORT = "4567";

    const request = requestFor("http://localhost:4567/api/boot", {
      host: "localhost:4567",
    });

    assert.equal(isAllowedOrigin(request, "http://localhost:4567"), true);
  });

  test("allows actual remote host when bound to 0.0.0.0", () => {
    process.env.GSD_WEB_HOST = "0.0.0.0";
    process.env.GSD_WEB_PORT = "4567";

    const request = requestFor("http://192.168.1.20:4567/api/switch-root", {
      host: "192.168.1.20:4567",
    });

    assert.equal(isAllowedOrigin(request, "http://192.168.1.20:4567"), true);
  });

  test("allows forwarded tunnel origin", () => {
    process.env.GSD_WEB_HOST = "127.0.0.1";
    process.env.GSD_WEB_PORT = "4567";

    const request = requestFor("http://127.0.0.1:4567/api/switch-root", {
      host: "127.0.0.1:4567",
      "x-forwarded-host": "macbook.example.ts.net",
      "x-forwarded-proto": "https",
    });

    assert.equal(isAllowedOrigin(request, "https://macbook.example.ts.net"), true);
  });

  test("allows explicit additional origins", () => {
    process.env.GSD_WEB_HOST = "127.0.0.1";
    process.env.GSD_WEB_PORT = "4567";
    process.env.GSD_WEB_ALLOWED_ORIGINS = "https://custom.example.com";

    const request = requestFor("http://127.0.0.1:4567/api/boot", {
      host: "127.0.0.1:4567",
    });

    assert.equal(isAllowedOrigin(request, "https://custom.example.com"), true);
  });

  test("allows bracketed IPv6 loopback host", () => {
    process.env.GSD_WEB_HOST = "127.0.0.1";
    process.env.GSD_WEB_PORT = "4567";

    const request = requestFor("http://[::1]:4567/api/boot", {
      host: "[::1]:4567",
    });

    assert.equal(isAllowedOrigin(request, "http://[::1]:4567"), true);
  });

  test("allows comma-separated forwarded host values", () => {
    process.env.GSD_WEB_HOST = "127.0.0.1";
    process.env.GSD_WEB_PORT = "4567";

    const request = requestFor("http://127.0.0.1:4567/api/switch-root", {
      host: "127.0.0.1:4567",
      "x-forwarded-host": "first.example.test, second.example.test",
      "x-forwarded-proto": "https",
    });

    assert.equal(isAllowedOrigin(request, "https://second.example.test"), true);
  });

  test("ignores invalid additional origins", () => {
    process.env.GSD_WEB_HOST = "127.0.0.1";
    process.env.GSD_WEB_PORT = "4567";
    process.env.GSD_WEB_ALLOWED_ORIGINS = "not a url,https://valid.example.com";

    const request = requestFor("http://127.0.0.1:4567/api/boot", {
      host: "127.0.0.1:4567",
    });

    assert.equal(isAllowedOrigin(request, "not a url"), false);
    assert.equal(isAllowedOrigin(request, "https://valid.example.com"), true);
  });

  test("rejects malformed origin values", () => {
    process.env.GSD_WEB_HOST = "127.0.0.1";
    process.env.GSD_WEB_PORT = "4567";

    const request = requestFor("http://127.0.0.1:4567/api/boot", {
      host: "127.0.0.1:4567",
    });

    assert.equal(isAllowedOrigin(request, "not a url"), false);
  });

  test("rejects unrelated origins", () => {
    process.env.GSD_WEB_HOST = "127.0.0.1";
    process.env.GSD_WEB_PORT = "4567";

    const request = requestFor("http://127.0.0.1:4567/api/boot", {
      host: "127.0.0.1:4567",
    });

    assert.equal(isAllowedOrigin(request, "https://evil.example.com"), false);
  });
});
