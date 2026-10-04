import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMailer, orderReceivedEmail, adminOrderNotificationEmail } from "./mailer.js";

describe("createMailer", () => {
  test("configured is false without both apiKey and fromAddress", () => {
    assert.equal(createMailer({}).configured, false);
    assert.equal(createMailer({ apiKey: "re_x" }).configured, false);
    assert.equal(createMailer({ fromAddress: "a@b.com" }).configured, false);
  });

  test("send() is a safe no-op when unconfigured", async () => {
    const mailer = createMailer({});
    const result = await mailer.send({ to: "a@b.com", subject: "x", html: "<p>x</p>", text: "x" });
    assert.equal(result.ok, false);
  });

  test("send() posts to Resend's API with the right shape", async () => {
    let capturedUrl;
    let capturedInit;
    const fetchImpl = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
    };
    const mailer = createMailer({ apiKey: "re_test", fromAddress: "hello@siteguardforms.com.au", fetchImpl });
    const result = await mailer.send({ to: "customer@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi" });

    assert.equal(result.ok, true);
    assert.equal(result.id, "email_123");
    assert.equal(capturedUrl, "https://api.resend.com/emails");
    assert.equal(capturedInit.headers.Authorization, "Bearer re_test");
    const body = JSON.parse(capturedInit.body);
    assert.equal(body.from, "hello@siteguardforms.com.au");
    assert.equal(body.to, "customer@example.com");
  });

  test("send() surfaces a non-2xx response as ok:false without throwing", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ message: "invalid from address" }), { status: 422 });
    const mailer = createMailer({ apiKey: "re_test", fromAddress: "bad", fetchImpl });
    const result = await mailer.send({ to: "a@b.com", subject: "x", html: "x", text: "x" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /422/);
  });

  test("send() surfaces a network error as ok:false without throwing", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNRESET");
    };
    const mailer = createMailer({ apiKey: "re_test", fromAddress: "a@b.com", fetchImpl });
    const result = await mailer.send({ to: "a@b.com", subject: "x", html: "x", text: "x" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /ECONNRESET/);
  });
});

describe("email templates", () => {
  test("orderReceivedEmail includes the project address and escapes the package name", () => {
    const { subject, html, text } = orderReceivedEmail({
      packageName: "Registers <Bundle>",
      projectAddress: "1 Example St, Melbourne",
    });
    assert.match(subject, /Registers/);
    assert.ok(html.includes("1 Example St, Melbourne"));
    assert.ok(!html.includes("<Bundle>")); // escaped, not raw-injected
    assert.ok(text.includes("1 Example St, Melbourne"));
    assert.ok(!/master/i.test(html) && !/master/i.test(text)); // no internal mastering-pipeline language
    assert.ok(/24 hours/i.test(html) && /24 hours/i.test(text));
    assert.ok(html.includes("hello@siteguardsystems.com.au") && text.includes("hello@siteguardsystems.com.au"));
  });

  test("adminOrderNotificationEmail lists every item, the total, and the Stripe session id", () => {
    const { subject, html, text } = adminOrderNotificationEmail({
      items: [
        { name: "Carpentry — Domestic", amountTotal: 54900 },
        { name: "SAF-SWMS-WP-006 — Balcony Waterproofing", amountTotal: 4900 },
      ],
      customerEmail: "buyer@example.com",
      clientName: "Acme <Builders>",
      projectAddress: "1 Example St, Melbourne",
      siteNotes: "Side gate access only",
      amountTotal: 59800,
      currency: "aud",
      sessionId: "cs_test_123",
    });
    assert.match(subject, /Acme/);
    assert.ok(!html.includes("<Builders>")); // escaped, not raw-injected
    assert.ok(html.includes("Carpentry") && html.includes("Balcony Waterproofing"));
    assert.ok(html.includes("$598.00"));
    assert.ok(html.includes("buyer@example.com"));
    assert.ok(html.includes("cs_test_123"));
    assert.ok(text.includes("Carpentry") && text.includes("cs_test_123"));
    assert.ok(/not retrieved/i.test(text)); // no parkResult passed -- must say so, not stay silent
  });

  test("adminOrderNotificationEmail reports a successful park with its folder path", () => {
    const { html, text } = adminOrderNotificationEmail({
      items: [{ name: "Carpentry — Domestic", amountTotal: 54900 }],
      customerEmail: "buyer@example.com",
      clientName: "Acme Builders",
      projectAddress: "1 Example St, Melbourne",
      amountTotal: 54900,
      currency: "aud",
      sessionId: "cs_test_123",
      parkResult: { ok: true, dir: "/home/dan/hseq-dev/var/parked-orders/cs_test_123" },
    });
    assert.ok(html.includes("parked for review"));
    assert.ok(html.includes("/home/dan/hseq-dev/var/parked-orders/cs_test_123"));
    assert.ok(text.includes("/home/dan/hseq-dev/var/parked-orders/cs_test_123"));
  });

  test("adminOrderNotificationEmail surfaces a failed park loudly, with affected codes", () => {
    const { html, text } = adminOrderNotificationEmail({
      items: [{ name: "Carpentry — Domestic", amountTotal: 54900 }],
      customerEmail: "buyer@example.com",
      clientName: "Acme Builders",
      projectAddress: "1 Example St, Melbourne",
      amountTotal: 54900,
      currency: "aud",
      sessionId: "cs_test_123",
      parkResult: {
        ok: false,
        reason: "hash mismatch",
        groups: [{ hash_mismatches: ["SAF-SWMS-CARP-001"], missing_source_files: [] }],
      },
    });
    assert.ok(/needs attention/i.test(html));
    assert.ok(html.includes("SAF-SWMS-CARP-001"));
    assert.ok(/needs attention/i.test(text));
    assert.ok(text.includes("SAF-SWMS-CARP-001"));
  });
});
