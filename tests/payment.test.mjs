import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createOrderStore } from "../api/_orders.js";
import { checkoutUrl, tokenHash } from "../api/_asaas.js";
import { createPaymentOrder, fulfillPaidOrder, handleCheckoutEvent, publicOrder } from "../api/_payment-flow.js";
import { createWebhookHandler } from "../api/asaas-webhook.js";
import { createStatusHandler } from "../api/order-status.js";
import { createCheckoutHandler } from "../api/create-checkout.js";
import directBooking from "../api/submit-booking.js";

const db = new PGlite();
await db.exec(await readFile(new URL("../db/001-payment-orders.sql", import.meta.url), "utf8"));
const store = createOrderStore((sql, params) => db.query(sql, params));
const config = { environment: "sandbox", appUrl: "http://localhost:5173", checkoutOrigin: "https://sandbox.asaas.com" };
const webhookToken = randomBytes(32).toString("hex");

function input() {
  return {
    orderId: randomUUID(), accessToken: randomBytes(32).toString("hex"),
    name: "Maria Teste", phone: "84999999999", unitCode: 1, objectiveId: "corporal", workRoutineId: "sentado",
    slot: { date: "09/10/2026", time: "14:30", professionalCode: "42", professionalName: "Profissional Teste" },
    // The caller cannot set the price or payment/booking status.
    amount_cents: 1, paid_at: new Date().toISOString(), bookingStatus: "confirmed"
  };
}

function mocks({ available = true, paymentStatus = "CONFIRMED", value = 89.90, existing = false, booking = { dis: true, codAgendamento: 888 }, bookingError = false } = {}) {
  const writes = [];
  const requests = [];
  async function belle(path, options) {
    if (options?.method === "POST") writes.push(path);
    if (path === "/cliente/listar") return existing ? { codigo: 456 } : [];
    if (path === "/agenda/disponibilidade") return [{ data: "09/10/2026", horarios: [{ codProf: "42", nome: "Profissional Teste", horarios: available ? [{ horario: "14:30", cod: "l" }] : [] }] }];
    if (path === "/cliente/gravar-lead") return { codigo: 1234 };
    if (path === "/agenda/gravar") {
      assert.match(options.body.observacao, /Pagamento Asaas confirmado/);
      if (bookingError) throw new Error("Timeout after Belle may have accepted the write");
      return booking;
    }
    throw new Error(`Unexpected Belle path: ${path}`);
  }
  async function provider(path, options) {
    requests.push({ path, ...options });
    if (path === "/checkouts") return { id: randomUUID() };
    if (path.startsWith("/payments?checkoutSession=")) return { data: [{ id: `pay_${randomUUID()}`, status: paymentStatus, billingType: "PIX", value }] };
    throw new Error(`Unexpected Asaas path: ${path}`);
  }
  return { store, belle, provider, writes, requests, config };
}

function paidEvent(order, overrides = {}) {
  return { id: `evt_${randomUUID()}`, event: "CHECKOUT_PAID", checkout: { id: order.checkout_id }, ...overrides };
}

async function request(handler, body, headers = {}) {
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value ? JSON.parse(value) : null; } };
  await handler({ method: "POST", body, headers }, res);
  return res;
}

try {
  const payload = input();
  const services = mocks();
  const pending = await createPaymentOrder(payload, services);
  assert.equal(pending.status, "pending");
  assert.equal(pending.amount_cents, 8990);
  assert.equal(pending.paid_at, null);
  assert.equal(pending.payload.paid_at, undefined);
  assert.deepEqual(services.writes, [], "No Belle writes before payment");
  const checkout = services.requests[0].body;
  assert.deepEqual(checkout.billingTypes, ["PIX", "CREDIT_CARD"]);
  assert.equal(checkout.items[0].value, 89.90);
  assert.equal(checkout.externalReference, pending.id);
  assert.ok(!checkout.callback.successUrl.includes(payload.accessToken), "Do not send access tokens to analytics or callback URLs");
  assert.equal((await createPaymentOrder(payload, services)).checkout_id, pending.checkout_id);
  assert.equal(services.requests.length, 1, "A retry cannot create a second checkout");
  await assert.rejects(createPaymentOrder({ ...payload, accessToken: randomBytes(32).toString("hex") }, services), { statusCode: 404 });

  const protectedRoute = await request(directBooking, payload);
  assert.equal(protectedRoute.statusCode, 402);
  assert.deepEqual(services.writes, []);
  const unconfigured = await request(createCheckoutHandler({ config: () => { throw new Error("Missing keys"); } }), payload);
  assert.equal(unconfigured.statusCode, 503);

  const event = paidEvent(pending);
  const webhook = createWebhookHandler({ token: () => webhookToken, processEvent: (value) => handleCheckoutEvent(value, services) });
  assert.equal((await request(webhook, event)).statusCode, 401);
  assert.equal((await request(webhook, event, { "asaas-access-token": "fake" })).statusCode, 401);
  assert.deepEqual(services.writes, []);
  const unpaid = mocks({ paymentStatus: "PENDING" });
  await assert.rejects(handleCheckoutEvent(event, unpaid));
  assert.deepEqual(unpaid.writes, []);
  const authorized = mocks({ paymentStatus: "AUTHORIZED" });
  await assert.rejects(handleCheckoutEvent(event, authorized));
  assert.deepEqual(authorized.writes, []);
  const wrongValue = mocks({ value: 1 });
  const wrongValueOrder = await createPaymentOrder(input(), mocks());
  await handleCheckoutEvent(paidEvent(wrongValueOrder), wrongValue);
  const wrongValueResult = await store.get(wrongValueOrder.id);
  assert.equal(wrongValueResult.status, "needs_attention");
  assert.equal(wrongValueResult.paid_at, null);
  assert.equal(wrongValueResult.attention_reason, "payment-amount-mismatch");
  assert.deepEqual(wrongValue.writes, []);

  // Even a forged success callback and caller-supplied paid flag can only read a pending order.
  const statusHandler = createStatusHandler({ store });
  const readPending = await request(statusHandler, { ...payload, paid: true });
  assert.equal(readPending.body.status, "pending");
  assert.equal(readPending.body.paymentConfirmed, false);
  assert.equal(readPending.headers["Cache-Control"], "no-store");
  assert.equal((await request(statusHandler, { ...payload, accessToken: "b".repeat(64) })).statusCode, 404);
  assert.deepEqual(services.writes, []);

  // Exercise two deliveries concurrently against the real PostgreSQL update conditions.
  const concurrent = await Promise.allSettled([
    handleCheckoutEvent(event, services),
    handleCheckoutEvent(paidEvent(pending), services)
  ]);
  assert.ok(concurrent.some((result) => result.status === "fulfilled"));
  const fulfilled = await store.get(pending.id);
  assert.equal(fulfilled.status, "confirmed");
  assert.ok(fulfilled.paid_at);
  assert.equal(fulfilled.booking_code, "888");
  assert.deepEqual(services.writes, ["/cliente/gravar-lead", "/agenda/gravar"]);
  await handleCheckoutEvent(event, services);
  await handleCheckoutEvent(paidEvent(pending), services);
  await handleCheckoutEvent(paidEvent(pending, { event: "CHECKOUT_EXPIRED" }), services);
  assert.equal((await store.get(pending.id)).status, "confirmed");
  assert.deepEqual(services.writes, ["/cliente/gravar-lead", "/agenda/gravar"], "Duplicate/late events cannot duplicate or undo the booking");
  const safe = publicOrder(fulfilled);
  assert.equal(safe.paymentConfirmed, true);
  assert.equal(safe.checkoutUrl, null);
  assert.ok(!JSON.stringify(safe).includes(payload.accessToken));
  assert.ok(!JSON.stringify(safe).includes(tokenHash(payload.accessToken)));

  // A stale slot after payment is preserved as paid and routed to the team, never booked blindly.
  const slotServices = mocks();
  const slotOrder = await createPaymentOrder(input(), slotServices);
  const unavailable = mocks({ available: false });
  const attention = await handleCheckoutEvent(paidEvent(slotOrder), unavailable);
  assert.equal(attention.status, "needs_attention");
  assert.equal((await store.get(slotOrder.id)).attention_reason, "slot-unavailable");
  assert.ok((await store.get(slotOrder.id)).paid_at);
  assert.deepEqual(unavailable.writes, []);

  const failedServices = mocks();
  const failedOrder = await createPaymentOrder(input(), failedServices);
  const ambiguous = mocks({ bookingError: true });
  const ambiguousEvent = paidEvent(failedOrder);
  await handleCheckoutEvent(ambiguousEvent, ambiguous);
  await handleCheckoutEvent(ambiguousEvent, ambiguous);
  assert.equal((await store.get(failedOrder.id)).status, "needs_attention");
  assert.deepEqual(ambiguous.writes, ["/cliente/gravar-lead", "/agenda/gravar"], "Timeout does not trigger another write to Belle");

  const rejectedServices = mocks();
  const rejectedOrder = await createPaymentOrder(input(), rejectedServices);
  await handleCheckoutEvent(paidEvent(rejectedOrder), mocks({ booking: { dis: "false" } }));
  assert.equal((await store.get(rejectedOrder.id)).status, "needs_attention");

  const cancelledServices = mocks();
  const cancelledOrder = await createPaymentOrder(input(), cancelledServices);
  await handleCheckoutEvent(paidEvent(cancelledOrder, { event: "CHECKOUT_CANCELED" }), cancelledServices);
  assert.equal((await store.get(cancelledOrder.id)).status, "cancelled");
  assert.deepEqual(cancelledServices.writes, []);
  await handleCheckoutEvent(paidEvent(cancelledOrder), cancelledServices);
  assert.equal((await store.get(cancelledOrder.id)).status, "confirmed", "Late genuine payment can still be reconciled");

  const interruptedServices = mocks();
  const interruptedOrder = await createPaymentOrder(input(), interruptedServices);
  const processing = await store.update(interruptedOrder.id, { status: "processing", paid_at: new Date().toISOString(), processing_at: new Date(Date.now() - 240000).toISOString() }, ["pending"]);
  assert.equal((await fulfillPaidOrder(processing, interruptedServices)).status, "needs_attention");
  assert.deepEqual(interruptedServices.writes, []);

  await assert.rejects(createPaymentOrder(input(), mocks({ existing: true })), { statusCode: 403 });
  await assert.rejects(createPaymentOrder(input(), mocks({ available: false })), { statusCode: 409 });
  assert.throws(() => checkoutUrl({ id: "test", link: "https://example.com/phishing" }, config));
  assert.deepEqual(await handleCheckoutEvent({ event: "PAYMENT_AUTHORIZED" }, services), { ignored: true });
  assert.deepEqual(await handleCheckoutEvent({ id: `evt_${randomUUID()}`, event: "CHECKOUT_PAID", checkout: { id: "unrelated-account-checkout" } }, services), { ignored: true });

  console.log("Payment flow passed: PostgreSQL persistence, unpaid/unauthenticated rejection, price validation, concurrent and repeated webhooks, payment-gated Belle booking, stale slots and ambiguous writes.");
} finally { await db.close(); }
