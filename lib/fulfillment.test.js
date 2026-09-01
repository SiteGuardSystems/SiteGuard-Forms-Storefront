import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createFulfillmentClient } from "./fulfillment.js";

const REQUEST = {
  sourceRedemptionId: "red_1",
  packageId: "registers-bundle",
  stripeCustomerId: "cus_a",
  customerEmail: "a@b.com",
  projectAddress: "1 Test St",
  clientName: "Acme Pty Ltd",
  siteNotes: "",
};

function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("fulfillment client", () => {
  test("posts the intake with the shared key and returns the factory's id", async () => {
    const fetchImpl = stubFetch(() => jsonResponse(201, { id: "req_1", deduplicated: false }));
    const client = createFulfillmentClient({
      baseUrl: "http://factory.test",
      apiKey: "secret",
      fetchImpl,
    });
    const result = await client.submit(REQUEST);

    assert.deepEqual(result, { ok: true, id: "req_1", deduplicated: false });
    assert.equal(fetchImpl.calls.length, 1);
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, "http://factory.test/api/storefront-fulfillment");
    assert.equal(init.headers["x-storefront-api-key"], "secret");
    assert.equal(JSON.parse(init.body).sourceRedemptionId, "red_1");
  });

  test("a trailing slash on the base url does not double up", async () => {
    const fetchImpl = stubFetch(() => jsonResponse(201, { id: "req_2" }));
    const client = createFulfillmentClient({
      baseUrl: "http://factory.test/",
      apiKey: "k",
      fetchImpl,
    });
    await client.submit(REQUEST);
    assert.equal(fetchImpl.calls[0].url, "http://factory.test/api/storefront-fulfillment");
  });

  test("an empty siteNotes is omitted rather than sent blank", async () => {
    const fetchImpl = stubFetch(() => jsonResponse(201, { id: "req_3" }));
    const client = createFulfillmentClient({ baseUrl: "http://f", apiKey: "k", fetchImpl });
    await client.submit({ ...REQUEST, siteNotes: "" });
    assert.equal("siteNotes" in JSON.parse(fetchImpl.calls[0].init.body), false);
  });

  test("reports a rejection instead of throwing, and keeps the status for a replay", async () => {
    const fetchImpl = stubFetch(() => jsonResponse(401, { error: "invalid key" }));
    const client = createFulfillmentClient({ baseUrl: "http://f", apiKey: "wrong", fetchImpl });
    const result = await client.submit(REQUEST);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "rejected");
    assert.equal(result.status, 401);
  });

  test("an unreachable factory is a value, not an exception", async () => {
    const fetchImpl = stubFetch(() => {
      throw Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" });
    });
    const client = createFulfillmentClient({ baseUrl: "http://f", apiKey: "k", fetchImpl });
    const result = await client.submit(REQUEST);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unreachable");
  });

  test("a timeout is reported as a timeout", async () => {
    const fetchImpl = stubFetch(() => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const client = createFulfillmentClient({ baseUrl: "http://f", apiKey: "k", fetchImpl });
    const result = await client.submit(REQUEST);
    assert.equal(result.reason, "timeout");
  });

  test("unconfigured is a supported state, not an error", async () => {
    const client = createFulfillmentClient({});
    assert.equal(client.enabled, false);
    assert.deepEqual(await client.submit(REQUEST), { ok: false, reason: "not-configured" });
  });

  test("a key without a base url stays disabled — half-configured must not half-send", async () => {
    assert.equal(createFulfillmentClient({ apiKey: "k" }).enabled, false);
    assert.equal(createFulfillmentClient({ baseUrl: "http://f" }).enabled, false);
  });
});
