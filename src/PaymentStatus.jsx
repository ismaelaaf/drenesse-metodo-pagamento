import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, MessageCircle, RefreshCw } from "lucide-react";
import { formatLongDate } from "./lib/domain.js";

const TERMINAL_STATUSES = new Set(["confirmed", "needs_attention", "cancelled", "expired", "setup_failed", "setup_unknown"]);

export default function PaymentStatus({ session, initialOrder, contactUrl }) {
  const [order, setOrder] = useState(initialOrder || null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);

  const checkStatus = useCallback(async (signal) => {
    if (inFlight.current) return null;
    if (!session.accessToken) {
      setError("Abra o acompanhamento no navegador em que preencheu os dados ou fale com o atendimento informando o número do pedido.");
      return null;
    }
    inFlight.current = true;
    setChecking(true);
    try {
      const response = await fetch("/api/order-status", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(session), signal
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Não foi possível consultar seu pedido.");
      setOrder(data);
      setError("");
      return data;
    } catch (requestError) {
      if (requestError.name !== "AbortError") setError(requestError.message || "Não foi possível consultar seu pedido.");
      return null;
    } finally { inFlight.current = false; setChecking(false); }
  }, [session.orderId, session.accessToken]);

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function poll() {
      const current = await checkStatus(controller.signal);
      if (!controller.signal.aborted && session.accessToken && !TERMINAL_STATUSES.has(current?.status)) timer = window.setTimeout(poll, 5000);
    }
    poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [checkStatus, session.accessToken]);

  const confirmed = order?.status === "confirmed";
  const needsAttention = order?.status === "needs_attention";
  const unpaidEnd = ["cancelled", "expired", "setup_failed", "setup_unknown"].includes(order?.status);
  const title = confirmed ? "Agendamento confirmado" : needsAttention ? (order.paymentConfirmed ? "Pagamento confirmado" : "Precisamos verificar seu pagamento") : unpaidEnd ? "Agendamento ainda não confirmado" : order?.paymentConfirmed ? "Confirmando seu agendamento" : "Aguardando confirmação do pagamento";
  const message = confirmed
    ? "Sua sessão do Método Drenesse foi registrada na agenda."
    : needsAttention
      ? order.paymentConfirmed
        ? "Seu pagamento foi recebido. Precisamos confirmar seu horário com a equipe. Não é necessário pagar novamente."
        : "Precisamos conferir os dados do pagamento com a equipe antes de registrar sua sessão. Fale com o atendimento antes de pagar novamente."
      : unpaidEnd
        ? "Este pedido precisa ser verificado com o atendimento antes de uma nova tentativa de pagamento."
        : order?.paymentConfirmed
          ? "Recebemos a confirmação do Asaas e estamos registrando sua sessão."
          : "O horário escolhido será confirmado após o pagamento e a gravação na agenda. Se você já pagou, aguarde a confirmação do Asaas.";

  return (
    <section className="form-card form-card--success" aria-live="polite" data-testid="payment-status">
      <div className="success-mark">{confirmed ? <Check aria-hidden="true" size={28} /> : <Loader2 aria-hidden="true" className={!unpaidEnd && !needsAttention ? "spin" : undefined} size={28} />}</div>
      <h2>{title}</h2>
      <p>{message}</p>
      {order?.summary && <p><strong>{order.summary.unit}</strong><br />{formatLongDate(order.summary.date)} às {order.summary.time}</p>}
      {confirmed && order.bookingCode && <p>Código do agendamento: {order.bookingCode}</p>}
      <p className="payment-order-id">Pedido: {session.orderId}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {order?.checkoutUrl && <a className="primary-button" href={order.checkoutUrl} rel="noreferrer">Ir para pagamento</a>}
      {!confirmed && !unpaidEnd && !needsAttention && <button className="ghost-button" type="button" disabled={checking} onClick={() => checkStatus()}><RefreshCw aria-hidden="true" size={18} /> {checking ? "Consultando" : "Atualizar confirmação"}</button>}
      <a className="primary-button" href={order?.whatsappUrl || contactUrl} rel="noreferrer"><MessageCircle aria-hidden="true" size={18} /> Falar com atendimento</a>
    </section>
  );
}
