import { createHash, timingSafeEqual } from "node:crypto";
import { PROMOTION } from "../src/lib/domain.js";

export function tokenHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function equalTokens(left, right) {
  return Boolean(left && right) && timingSafeEqual(Buffer.from(tokenHash(left)), Buffer.from(tokenHash(right)));
}

export function paymentConfig() {
  const environment = process.env.ASAAS_ENVIRONMENT || "sandbox";
  if (!["sandbox", "production"].includes(environment)) throw new Error("Ambiente Asaas inválido.");
  const appUrl = new URL(process.env.APP_URL || "http://localhost:5173");
  if (environment === "production" && appUrl.protocol !== "https:") throw new Error("APP_URL deve usar HTTPS.");
  return {
    environment,
    appUrl: appUrl.origin,
    apiUrl: environment === "production" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3",
    checkoutOrigin: environment === "production" ? "https://asaas.com" : "https://sandbox.asaas.com",
    apiKey: process.env.ASAAS_API_KEY || "",
    webhookToken: process.env.ASAAS_WEBHOOK_TOKEN || ""
  };
}

export function requirePaymentConfig() {
  const config = paymentConfig();
  if (!config.apiKey || config.webhookToken.length < 32 || !process.env.DATABASE_URL || !process.env.BELLE_API_TOKEN) {
    throw new Error("Integração de pagamento não configurada.");
  }
  return config;
}

export async function asaasFetch(path, { method = "GET", body } = {}) {
  const config = paymentConfig();
  if (!config.apiKey) throw new Error("Asaas não configurado.");
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: { access_token: config.apiKey, "Content-Type": "application/json", "User-Agent": "Drenesse-Pagamento/1.0" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const error = new Error(`Asaas retornou HTTP ${response.status}.`);
    // A network timeout/5xx might have created a checkout; do not automatically create a second one.
    error.definitive = response.status >= 400 && response.status < 500;
    throw error;
  }
  return response.json();
}

export function buildCheckoutBody(order, config = paymentConfig()) {
  const callbackUrl = new URL(config.appUrl);
  callbackUrl.searchParams.set("pedido", order.id);
  callbackUrl.hash = "formulario";
  return {
    billingTypes: ["PIX", "CREDIT_CARD"],
    chargeTypes: ["DETACHED"],
    minutesToExpire: 10,
    externalReference: order.id,
    callback: { successUrl: callbackUrl.href, cancelUrl: callbackUrl.href, expiredUrl: callbackUrl.href },
    items: [{ name: PROMOTION.serviceName, description: `Sessão de ${PROMOTION.duration} minutos`, quantity: 1, value: order.amount_cents / 100 }]
    // Keep the existing LP fields. Asaas collects the additional payer details in its hosted checkout.
  };
}

export function checkoutUrl(checkout, config = paymentConfig()) {
  const fallback = new URL("/checkoutSession/show", config.checkoutOrigin);
  fallback.searchParams.set("id", checkout.id);
  const url = new URL(checkout.link || fallback.href);
  const allowedHosts = config.environment === "production" ? ["asaas.com", "www.asaas.com"] : ["sandbox.asaas.com"];
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) throw new Error("Link de checkout inválido.");
  return url.href;
}

export async function verifyCheckoutPayment(order, fetcher = asaasFetch) {
  const result = await fetcher(`/payments?checkoutSession=${encodeURIComponent(order.checkout_id)}&limit=100`);
  const payments = (result.data || []).filter((payment) => !payment.deleted);
  // This campaign is a single, non-installment purchase. Never fulfill an authorized/pending charge.
  if (result.hasMore || payments.length !== 1) throw new Error("Confirmação financeira ainda indisponível.");
  const payment = payments[0];
  if (!["CONFIRMED", "RECEIVED"].includes(payment.status) || !["PIX", "CREDIT_CARD"].includes(payment.billingType)) {
    throw new Error("Pagamento ainda não confirmado.");
  }
  if (Math.round(Number(payment.value) * 100) !== order.amount_cents) {
    throw Object.assign(new Error("Valor do pagamento divergente."), { code: "PAYMENT_AMOUNT_MISMATCH", paymentId: payment.id });
  }
  return payment;
}
