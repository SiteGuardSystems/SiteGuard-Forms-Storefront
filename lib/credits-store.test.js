import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { createCreditsStore } from "./credits-store.js";

let dir;
let store;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "credits-store-test-"));
  store = createCreditsStore(dir);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("credits store", () => {
  test("grants credits and reports them in the balance", async () => {
    await store.grantCredits({
      stripeCustomerId: "cus_a",
      email: "a@b.com",
      packageId: "registers-bundle",
      amount: 5,
      source: "project-pack",
      sourceId: "cs_1",
    });
    const balance = await store.getBalance("cus_a");
    assert.equal(balance.email, "a@b.com");
    assert.equal(balance.packages["registers-bundle"], 5);
  });

  test("getBalance returns null for an unknown customer", async () => {
    assert.equal(await store.getBalance("cus_does_not_exist"), null);
  });

  test("wasAlreadyGranted dedupes by sourceId (webhook redelivery guard)", async () => {
    assert.equal(await store.wasAlreadyGranted("cs_1"), true); // granted above
    assert.equal(await store.wasAlreadyGranted("cs_never_seen"), false);
  });

  test("redeemCredit decrements the balance by one", async () => {
    const remaining = await store.redeemCredit({
      stripeCustomerId: "cus_a",
      email: "a@b.com",
      packageId: "registers-bundle",
      projectAddress: "1 Test St",
      clientName: "Acme Pty Ltd",
      siteNotes: "",
    });
    assert.equal(remaining, 4);
    const balance = await store.getBalance("cus_a");
    assert.equal(balance.packages["registers-bundle"], 4);
  });

  test("redeemCredit throws NO_CREDITS once a package's balance hits zero", async () => {
    await store.grantCredits({
      stripeCustomerId: "cus_b",
      email: "b@b.com",
      packageId: "itp-bundle",
      amount: 1,
      source: "project-pack",
      sourceId: "cs_2",
    });
    await store.redeemCredit({
      stripeCustomerId: "cus_b",
      email: "b@b.com",
      packageId: "itp-bundle",
      projectAddress: "2 Test St",
      clientName: "Beta Co",
    });
    await assert.rejects(
      () =>
        store.redeemCredit({
          stripeCustomerId: "cus_b",
          email: "b@b.com",
          packageId: "itp-bundle",
          projectAddress: "3 Test St",
          clientName: "Beta Co",
        }),
      (err) => err.code === "NO_CREDITS",
    );
  });

  test("grantCredits accumulates across multiple grants for the same package", async () => {
    await store.grantCredits({
      stripeCustomerId: "cus_c",
      email: "c@b.com",
      packageId: "registers-bundle",
      amount: 5,
      source: "subscription-initial",
      sourceId: "cs_3",
    });
    await store.grantCredits({
      stripeCustomerId: "cus_c",
      email: "c@b.com",
      packageId: "registers-bundle",
      amount: 5,
      source: "subscription-renewal",
      sourceId: "in_1",
    });
    const balance = await store.getBalance("cus_c");
    assert.equal(balance.packages["registers-bundle"], 10);
  });
});
