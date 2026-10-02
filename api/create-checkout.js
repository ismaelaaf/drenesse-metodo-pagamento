import { allowMethods, buildBenefitUsedWhatsapp, readJsonBody, sendJson } from "./_belle.js";
import { requirePaymentConfig } from "./_asaas.js";
import { createPaymentOrder, publicOrder } from "./_payment-flow.js";

export function createCheckoutHandler({ createOrder = createPaymentOrder, config = requirePaymentConfig } = {}) {
  return async (req, res) => {
    if (!allowMethods(req, res, ["POST"])) return;
    res.setHeader("Cache-Control", "no-store");
    let input;
    try { input = await readJsonBody(req); } catch { return sendJson(res, 400, { message: "JSON inválido." }); }
    try { config(); } catch { return sendJson(res, 503, { message: "O pagamento online ainda está sendo configurado. Fale com nosso atendimento." }); }
    try {
      const order = await createOrder(input);
      return sendJson(res, 200, publicOrder(order));
    } catch (error) {
      const status = error.statusCode || 503;
      return sendJson(res, status, {
        message: error.statusCode ? error.message : "Não foi possível preparar o pagamento agora. Tente novamente mais tarde.",
        ...(status === 403 ? { bookingStatus: "ineligible", whatsappUrl: buildBenefitUsedWhatsapp() } : {})
      });
    }
  };
}

export default createCheckoutHandler();
