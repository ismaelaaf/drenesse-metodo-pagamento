import { belleFetch, extractClientCode } from "./_belle.js";
import { PROMOTION, SELLER, UNITS, getObjective, getUnit, getWorkRoutine, normalizeBrazilianMobile, validateMobile } from "../src/lib/domain.js";

export const BOOKING_ENDPOINT = "/agenda/gravar";

export async function findExistingClientByPhone(phone, preferredUnitCode, fetcher = belleFetch) {
  const normalizedPhone = normalizeBrazilianMobile(phone);
  const orderedUnitCodes = [Number(preferredUnitCode), ...UNITS.map((unit) => unit.code).filter((code) => code !== Number(preferredUnitCode))];
  for (const unitCode of orderedUnitCodes) {
    const client = await fetcher("/cliente/listar", { query: { cpf: "", id: "", codEstab: unitCode, email: "", celular: normalizedPhone } });
    const clientCode = extractClientCode(client);
    if (clientCode) return { clientCode, unitCode };
  }
  return null;
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
  if (!getWorkRoutine(payload.workRoutineId)) return "Rotina inválida.";
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(payload.slot?.date || "") || !/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.slot?.time || "") || !/^\d{1,12}$/.test(String(payload.slot?.professionalCode || ""))) return "Horário inválido.";
  return "";
}
