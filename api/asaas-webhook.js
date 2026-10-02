import { equalTokens } from "./_asaas.js";
import { allowMethods, readJsonBody, sendJson } from "./_belle.js";
import { handleCheckoutEvent } from "./_payment-flow.js";

export function createWebhookHandler({ processEvent = handleCheckoutEvent, token = () => process.env.ASAAS_WEBHOOK_TOKEN } = {}) {
  return async (req, res) => {
    if (!allowMethods(req, res, ["POST"])) return;
    res.setHeader("Cache-Control", "no-store");
    const expected = token();
    if (!expected || expected.length < 32) return sendJson(res, 503, { message: "Webhook não configurado." });
    if (!equalTokens(req.headers["asaas-access-token"], expected)) return sendJson(res, 401, { message: "Notificação não autenticada." });
    let event;
    try { event = await readJsonBody(req); } catch { return sendJson(res, 400, { message: "JSON inválido." }); }
    try {
      const result = await processEvent(event);
      sendJson(res, 200, result);
    } catch (error) {
      // Keep failures retryable; order and event records survive serverless restarts.
      sendJson(res, error.statusCode === 400 ? 400 : 503, { message: "Não foi possível processar a notificação agora." });
    }
  };
}

export default createWebhookHandler();
