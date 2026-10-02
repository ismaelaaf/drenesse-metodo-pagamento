const STORAGE_KEY = "drenesse-payment-order-v1";

export function newPaymentSession() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { orderId: crypto.randomUUID(), accessToken: [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}

export function savePaymentSession(session) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* Checkout still works in the current tab. */ }
}

export function returnPaymentSession() {
  const orderId = new URLSearchParams(window.location.search).get("pedido");
  if (!orderId) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return saved?.orderId === orderId && /^[a-f0-9]{64}$/i.test(saved.accessToken || "") ? saved : { orderId, accessToken: "" };
  } catch { return { orderId, accessToken: "" }; }
}
