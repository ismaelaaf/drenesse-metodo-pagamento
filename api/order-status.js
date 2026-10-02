import { allowMethods, readJsonBody, sendJson } from "./_belle.js";
import { tokenHash } from "./_asaas.js";
import { orderStore } from "./_orders.js";
import { ACCESS_TOKEN_PATTERN, ORDER_ID_PATTERN, publicOrder } from "./_payment-flow.js";

export function createStatusHandler({ store = orderStore } = {}) {
  return async (req, res) => {
    if (!allowMethods(req, res, ["POST"])) return;
    res.setHeader("Cache-Control", "no-store");
    let input;
    try { input = await readJsonBody(req); } catch { return sendJson(res, 400, { message: "JSON inválido." }); }
    if (!ORDER_ID_PATTERN.test(input?.orderId || "") || !ACCESS_TOKEN_PATTERN.test(input?.accessToken || "")) {
      return sendJson(res, 404, { message: "Pedido não encontrado." });
    }
    try {
      const order = await store.get(input.orderId);
      if (!order || order.access_token_hash !== tokenHash(input.accessToken)) return sendJson(res, 404, { message: "Pedido não encontrado." });
      // Status consultation cannot book, mark a payment as paid, or consume callback parameters as proof.
      return sendJson(res, 200, publicOrder(order));
    } catch { return sendJson(res, 503, { message: "Não foi possível consultar seu pedido agora." }); }
  };
}

export default createStatusHandler();
