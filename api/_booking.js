import { belleFetch, extractClientCode, isWholeHourSlot } from "./_belle.js";
import { PROMOTION, SELLER, UNITS, getInvestment, getObjective, getUnit, getWorkRoutine, normalizeBrazilianMobile, validateMobile } from "../src/lib/domain.js";

export const BOOKING_ENDPOINT = "/agenda/gravar";
export const RECENT_APPOINTMENT_DAYS = 30;

function orderedUnitCodes(preferredUnitCode) {
  return [Number(preferredUnitCode), ...UNITS.map((unit) => unit.code).filter((code) => code !== Number(preferredUnitCode))];
}

export async function findExistingClientsByPhone(phone, preferredUnitCode, fetcher = belleFetch) {
  const normalizedPhone = normalizeBrazilianMobile(phone);
  const clients = [];
  for (const unitCode of orderedUnitCodes(preferredUnitCode)) {
    const client = await fetcher("/cliente/listar", { query: { cpf: "", id: "", codEstab: unitCode, email: "", celular: normalizedPhone } });
    const clientCode = extractClientCode(client);
    if (clientCode) clients.push({ clientCode, unitCode });
  }
  return clients;
}

export async function findExistingClientByPhone(phone, preferredUnitCode, fetcher = belleFetch) {
  return (await findExistingClientsByPhone(phone, preferredUnitCode, fetcher))[0] || null;
}

function brazilDate(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
}

function parseBelleDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatBelleDate(date) {
  return `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

export async function checkPhoneEligibility(
  phone,
  preferredUnitCode,
  { fetcher = belleFetch, now = () => new Date() } = {}
) {
  const clients = await findExistingClientsByPhone(phone, preferredUnitCode, fetcher);
  if (!clients.length) return { eligible: true, clients, recentAppointment: null };

  const normalizedPhone = normalizeBrazilianMobile(phone);
  const today = brazilDate(now());
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - RECENT_APPOINTMENT_DAYS);
  const queryRange = { dtInicio: formatBelleDate(cutoff), dtFim: formatBelleDate(today) };

  for (const client of clients) {
    const appointments = await fetcher("/agendamentos/finalizados", {
      query: { codEstab: client.unitCode, ...queryRange }
    });
    const rows = Array.isArray(appointments) ? appointments : appointments ? [appointments] : [];
    const recentAppointment = rows.find((appointment) => {
      const appointmentClient = appointment?.cliente || {};
      const sameClient = String(appointmentClient.cod || appointmentClient.codigo || "") === String(client.clientCode)
        || normalizeBrazilianMobile(appointmentClient.celular || "") === normalizedPhone;
      const appointmentDate = parseBelleDate(appointment?.dtAgenda);
      return sameClient && appointmentDate && appointmentDate > cutoff && appointmentDate <= today;
    });
    if (recentAppointment) return { eligible: false, clients, recentAppointment };
  }

  return { eligible: true, clients, recentAppointment: null };
}

export function buildBookingBody({ leadCode, unit, objective, payload, observation }) {
  return {
    codCli: Number(leadCode), codEstab: unit.code,
    prof: { cod_usuario: String(payload.slot.professionalCode), nom_usuario: payload.slot.professionalName || "Profissional Drenesse" },
    dtAgd: payload.slot.date, hri: payload.slot.time,
    serv: [{ codServico: PROMOTION.serviceCode, nome: PROMOTION.serviceName, tempo: PROMOTION.duration,
      label: PROMOTION.serviceLabel, codSaldo: "", usaDia: "", diaRetorno: 0 }],
    codPlano: "", agSala: false, codSala: 0, codVendedor: SELLER.code,
    tipoObs: objective.belleObservationCode, temPreferencia: false, observacao: observation
  };
}

export function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return "Payload inválido.";
  if (typeof payload.name !== "string" || payload.name.trim().length < 2 || payload.name.length > 150) return "Nome inválido.";
  const phoneError = validateMobile(payload.phone);
  if (phoneError) return phoneError;
  if (!getUnit(payload.unitCode)) return "Unidade inválida.";
  if (!getObjective(payload.objectiveId)) return "Objetivo inválido.";
  if (!getInvestment(payload.investmentId)) return "Investimento inválido.";
  if (!getWorkRoutine(payload.workRoutineId)) return "Rotina inválida.";
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(payload.slot?.date || "") || !isWholeHourSlot(payload.slot?.time) || !/^\d{1,12}$/.test(String(payload.slot?.professionalCode || ""))) return "Horário inválido.";
  return "";
}
