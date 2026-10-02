import { PROMOTION, getObjective, getUnit, getWorkRoutine, normalizeBrazilianMobile } from "../src/lib/domain.js";
import { belleFetch, buildObservation, extractClientCode, flattenAvailability, getServerConfig, buildFallbackWhatsapp } from "./_belle.js";
import { BOOKING_ENDPOINT, buildBookingBody, findExistingClientByPhone, validatePayload } from "./_booking.js";
import { buildAvailabilityQuery } from "./availability.js";
import { asaasFetch, buildCheckoutBody, checkoutUrl, tokenHash, verifyCheckoutPayment } from "./_asaas.js";
import { orderStore } from "./_orders.js";

export const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ACCESS_TOKEN_PATTERN = /^[0-9a-f]{64}$/i;

function flowError(message, statusCode = 503) {
  return Object.assign(new Error(message), { statusCode });
}

export async function availableSlot(payload, fetcher = belleFetch) {
  const raw = await fetcher("/agenda/disponibilidade", { query: buildAvailabilityQuery(payload.unitCode, payload.slot.date) });
  return flattenAvailability(raw).some((day) => day.date === payload.slot.date && day.slots.some((slot) =>
    slot.time === payload.slot.time && String(slot.professionalCode) === String(payload.slot.professionalCode)
  ));
}

export async function createPaymentOrder(input, { store = orderStore, provider = asaasFetch, belle = belleFetch, config } = {}) {
  const validation = validatePayload(input);
  if (validation) throw flowError(validation, 400);
  if (!ORDER_ID_PATTERN.test(input.orderId || "") || !ACCESS_TOKEN_PATTERN.test(input.accessToken || "")) {
    throw flowError("Identificador do pedido inválido.", 400);
  }
  const existingOrder = await store.get(input.orderId);
  if (existingOrder) {
    if (existingOrder.access_token_hash !== tokenHash(input.accessToken)) throw flowError("Pedido não encontrado.", 404);
    if (["pending", "confirmed", "paid", "processing", "needs_attention"].includes(existingOrder.status)) return existingOrder;
    if (existingOrder.status === "creating") throw flowError("Pedido em preparação. Tente novamente em alguns instantes.", 409);
    throw flowError("Este pedido precisa ser verificado pelo atendimento antes de uma nova tentativa.", 409);
  }

  const payload = {
    name: String(input.name).trim().slice(0, 150), phone: normalizeBrazilianMobile(input.phone),
    unitCode: Number(input.unitCode), objectiveId: input.objectiveId, workRoutineId: input.workRoutineId,
    slot: { date: input.slot.date, time: input.slot.time, professionalCode: String(input.slot.professionalCode), professionalName: String(input.slot.professionalName || "Profissional Drenesse").slice(0, 100) },
    tracking: Object.fromEntries(["page", "referrer", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].map((key) => [key, String(input.tracking?.[key] || "").slice(0, 500)]))
  };
  if (await findExistingClientByPhone(payload.phone, payload.unitCode, belle)) throw flowError("Este WhatsApp já está cadastrado e o benefício é limitado a uma utilização por pessoa.", 403);
  if (!await availableSlot(payload, belle)) throw flowError("Este horário não está mais disponível. Escolha outra opção antes de pagar.", 409);

  const order = await store.create({ id: input.orderId, access_token_hash: tokenHash(input.accessToken), payload, amount_cents: PROMOTION.promotionalPriceCents });
  if (!order) throw flowError("Pedido em preparação. Tente novamente em alguns instantes.", 409);
  try {
    const checkout = await provider("/checkouts", { method: "POST", body: buildCheckoutBody(order, config) });
    if (!checkout.id) throw new Error("Checkout sem identificador.");
    const updated = await store.update(order.id, { status: "pending", checkout_id: checkout.id, checkout_url: checkoutUrl(checkout, config) }, ["creating"]);
    // A very fast webhook can already have advanced the persisted order.
    return updated || await store.get(order.id);
  } catch (error) {
    await store.update(order.id, { status: error.definitive ? "setup_failed" : "setup_unknown", attention_reason: "checkout-creation" }, ["creating"]);
    throw flowError("Não foi possível preparar o pagamento. Seus dados foram preservados; fale com o atendimento antes de tentar novamente.");
  }
}

export async function fulfillPaidOrder(order, { store = orderStore, belle = belleFetch, now = () => new Date() } = {}) {
  if (order.status === "processing") {
    if (now().getTime() - new Date(order.processing_at).getTime() < 180000) throw flowError("Agendamento em processamento.");
    // A previous invocation may have reached Belle before it was interrupted. Never blindly repeat it.
    return await store.update(order.id, { status: "needs_attention", attention_reason: "interrupted-booking" }, ["processing"]) || await store.get(order.id);
  }
  if (order.status !== "paid" || !order.paid_at) return order;
  const claimed = await store.update(order.id, { status: "processing", processing_at: now().toISOString() }, ["paid"]);
  if (!claimed) {
    const current = await store.get(order.id);
    if (current.status === "processing") throw flowError("Agendamento em processamento.");
    return current;
  }
  const payload = claimed.payload;
  const unit = getUnit(payload.unitCode);
  const objective = getObjective(payload.objectiveId);
  const workRoutine = getWorkRoutine(payload.workRoutineId);
  let reason = "availability-error";
  try {
    if (!await availableSlot(payload, belle)) {
      return await store.update(order.id, { status: "needs_attention", attention_reason: "slot-unavailable" }, ["processing"]);
    }
    reason = "eligibility-changed";
    if (await findExistingClientByPhone(payload.phone, unit.code, belle)) {
      return await store.update(order.id, { status: "needs_attention", attention_reason: reason }, ["processing"]);
    }
    const observation = `${buildObservation({ ...payload, unit, objective, workRoutine })} | Pagamento Asaas confirmado | Pedido: ${order.id} | Cobrança: ${order.payment_id}`;
    reason = "lead-creation";
    const lead = await belle("/cliente/gravar-lead", { method: "POST", body: {
      nome: payload.name, ddiCelular: "+55", celular: payload.phone, email: "", cpf: "",
      observacao: observation, tpOrigem: "Campanha", codOrigem: getServerConfig().originCode, codEstab: unit.code
    } });
    const leadCode = extractClientCode(lead);
    if (!leadCode) throw new Error("Cadastro sem código.");
    await store.update(order.id, { lead_code: leadCode }, ["processing"]);
    reason = "booking-response";
    const booking = await belle(BOOKING_ENDPOINT, { method: "POST", body: buildBookingBody({ leadCode, unit, objective, payload, observation }) });
    const confirmed = booking?.dis === true || booking?.dis === 1 || booking?.dis === "1" || booking?.dis === "true";
    return await store.update(order.id, {
      status: confirmed ? "confirmed" : "needs_attention", booking_code: String(booking?.codAgendamento || booking?.codigo || ""),
      attention_reason: confirmed ? null : "booking-rejected"
    }, ["processing"]);
  } catch {
    // Writes to Belle are not safely repeatable after timeouts. Keep the paid order for human reconciliation.
    return await store.update(order.id, { status: "needs_attention", attention_reason: reason }, ["processing"]);
  }
}

export async function handleCheckoutEvent(event, { store = orderStore, provider = asaasFetch, belle = belleFetch } = {}) {
  if (!event || typeof event !== "object") throw flowError("Evento inválido.", 400);
  const supported = ["CHECKOUT_PAID", "CHECKOUT_CANCELED", "CHECKOUT_EXPIRED"];
  if (!supported.includes(event.event)) return { ignored: true };
  if (!event.id || typeof event.id !== "string" || !event.checkout?.id || typeof event.checkout.id !== "string") throw flowError("Evento inválido.", 400);
  await store.receiveEvent(event);
  let order = await store.forCheckout(event.checkout.id, event.checkout.externalReference);
  if (!order) {
    // Account-level webhooks also include purchases unrelated to this LP. Do not block their queue.
    await store.completeEvent(event.id);
    return { ignored: true };
  }
  if (!order.checkout_id) {
    order = await store.update(order.id, { checkout_id: event.checkout.id }, ["creating", "setup_unknown"]) || await store.get(order.id);
  }
  if (event.event === "CHECKOUT_PAID") {
    if (!order.paid_at) {
      let payment;
      try {
        payment = await verifyCheckoutPayment(order, provider);
      } catch (error) {
        if (error.code !== "PAYMENT_AMOUNT_MISMATCH") throw error;
        order = await store.update(order.id, {
          status: "needs_attention", payment_id: error.paymentId, attention_reason: "payment-amount-mismatch"
        }, ["creating", "pending", "setup_unknown", "cancelled", "expired"]) || await store.get(order.id);
        await store.completeEvent(event.id);
        return { received: true, status: order.status };
      }
      order = await store.update(order.id, { status: "paid", payment_id: payment.id, paid_at: new Date().toISOString() }, ["creating", "pending", "setup_unknown", "cancelled", "expired"]) || await store.get(order.id);
    }
    order = await fulfillPaidOrder(order, { store, belle });
  } else if (!order.paid_at) {
    order = await store.update(order.id, { status: event.event === "CHECKOUT_EXPIRED" ? "expired" : "cancelled" }, ["creating", "pending", "setup_unknown"]) || await store.get(order.id);
  }
  await store.completeEvent(event.id);
  return { received: true, status: order.status };
}

export function publicOrder(order) {
  const payload = order.payload;
  const whatsapp = new URL(buildFallbackWhatsapp(payload, order.status === "confirmed" ? "confirmed" : "fallback", order.booking_code));
  const message = [whatsapp.searchParams.get("text"), `Pedido: ${order.id}`, order.paid_at ? "Pagamento confirmado pelo Asaas." : "Gostaria de verificar o pagamento do meu pedido."].join("\n");
  whatsapp.searchParams.set("text", message);
  return {
    orderId: order.id, status: order.status, paymentConfirmed: Boolean(order.paid_at),
    checkoutUrl: order.status === "pending" ? order.checkout_url : null,
    bookingCode: order.status === "confirmed" ? order.booking_code : null,
    summary: { unit: getUnit(payload.unitCode)?.name, date: payload.slot.date, time: payload.slot.time },
    whatsappUrl: whatsapp.href
  };
}
