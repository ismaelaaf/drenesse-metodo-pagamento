import { allowMethods, readJsonBody, sendJson } from "./_belle.js";
import {
  formatPhone,
  getInvestment,
  getObjective,
  getUnit,
  normalizeBrazilianMobile,
  validateMobile
} from "../src/lib/domain.js";

const DEFAULT_BASE_URL = "https://api.app.leverconversas.com.br";
const DEFAULT_PANEL_ID = "a3ee4cf3-291f-4c8f-8535-e3414642951a";
const DEFAULT_STEP_ID = "44586803-6791-41fd-b95a-826902688a25";
const LANDING_SOURCE = "Landing Método Drenesse";
const CARD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CUSTOM_FIELD_NAMES = Object.freeze({
  unit: "Unidade",
  entryDate: "Data de entrada",
  objective: "Principal incômodo"
});

export function getLeverConfig() {
  return {
    token: process.env.LEVER_API_TOKEN || "",
    baseUrl: (process.env.LEVER_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ""),
    panelId: process.env.LEVER_PANEL_ID || DEFAULT_PANEL_ID,
    stepId: process.env.LEVER_STEP_ID || DEFAULT_STEP_ID
  };
}

function getLeverHeaders(config) {
  return {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json"
  };
}

function getResponseEntity(payload) {
  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") {
    return payload.data;
  }
  return payload;
}

function getResponseList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeLeverLabel(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function flattenCustomFields(fields) {
  return fields.flatMap((field) => [field, ...flattenCustomFields(Array.isArray(field?.children) ? field.children : [])]);
}

function findCustomField(fields, name) {
  const normalizedName = normalizeLeverLabel(name);
  return flattenCustomFields(fields).find((field) => normalizeLeverLabel(field?.name) === normalizedName && field?.key);
}

function brazilDate(value) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function customFieldValue(field, candidates, now) {
  if (field.type === "DATE") return brazilDate(now);
  if (field.type === "DATETIME") return now.toISOString();
  if (field.type === "SINGLESELECT") {
    const option = (field.options || []).find((item) => candidates.some((candidate) =>
      normalizeLeverLabel(item?.name) === normalizeLeverLabel(candidate)
    ));
    if (!option?.id) throw new Error(`Opção não encontrada para o campo ${field.name}.`);
    return option.id;
  }
  return candidates[0];
}

export function buildLeverCustomFields(
  fields,
  { unit, objective, entryDate = new Date(), includeUnit = false, includeObjective = false } = {}
) {
  const result = {};
  const entryDateField = findCustomField(fields, CUSTOM_FIELD_NAMES.entryDate);
  if (!entryDateField) throw new Error(`Campo personalizado não encontrado: ${CUSTOM_FIELD_NAMES.entryDate}.`);
  result[entryDateField.key] = customFieldValue(entryDateField, [brazilDate(entryDate)], entryDate);

  if (includeUnit) {
    const unitField = findCustomField(fields, CUSTOM_FIELD_NAMES.unit);
    if (!unitField) throw new Error(`Campo personalizado não encontrado: ${CUSTOM_FIELD_NAMES.unit}.`);
    result[unitField.key] = customFieldValue(unitField, [unit.name, unit.shortName], entryDate);
  }

  if (includeObjective) {
    const objectiveField = findCustomField(fields, CUSTOM_FIELD_NAMES.objective);
    if (!objectiveField) throw new Error(`Campo personalizado não encontrado: ${CUSTOM_FIELD_NAMES.objective}.`);
    result[objectiveField.key] = customFieldValue(objectiveField, [objective.label], entryDate);
  }

  return result;
}

async function requestLeverJson(
  url,
  { method = "GET", body, config = getLeverConfig(), fetcher = fetch, retries = 1 } = {}
) {
  if (!config.token) throw new Error("LEVER_API_TOKEN não configurado.");

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetcher(url, {
        method,
        headers: getLeverHeaders(config),
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const text = await response.text();
      let payload = {};
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = {};
        }
      }

      if (response.ok) return payload;

      const error = new Error(`Lever API respondeu com status ${response.status}.`);
      error.statusCode = response.status;
      error.payload = payload;
      lastError = error;
      if (response.status < 500 && response.status !== 429) throw error;
    } catch (error) {
      lastError = error;
      if (error.statusCode && error.statusCode < 500 && error.statusCode !== 429) throw error;
    }
  }

  throw lastError || new Error("Não foi possível acessar a Lever.");
}

export async function listLeverPanelCustomFields(
  { config = getLeverConfig(), fetcher = fetch } = {}
) {
  const payload = await requestLeverJson(
    `${config.baseUrl}/crm/v1/panel/${encodeURIComponent(config.panelId)}/custom-fields?NestedList=false`,
    { config, fetcher }
  );
  return getResponseList(payload);
}

export function buildLeverContactPayload({ name, phone }) {
  return {
    name: String(name).trim(),
    phoneNumber: `+55|${normalizeBrazilianMobile(phone)}`
  };
}

export function buildLeverDescription({ phone, unit, objective, investment }) {
  const normalizedPhone = normalizeBrazilianMobile(phone);
  return [
    `WhatsApp: +55 ${formatPhone(normalizedPhone)}`,
    `Origem: ${LANDING_SOURCE}`,
    unit ? `Unidade: ${unit.name}` : "",
    objective ? `Principal incômodo: ${objective.label}` : "",
    investment ? `Investimento mensal: ${investment.label}` : ""
  ].filter(Boolean).join("\n");
}

export function buildLeverCardPayload(
  { name, phone, contactId, customFields = {} },
  config = getLeverConfig()
) {
  if (!contactId) throw new Error("O card da Lever precisa estar vinculado a um contato.");
  return {
    title: String(name).trim(),
    description: buildLeverDescription({ phone }),
    stepId: config.stepId,
    contactIds: [String(contactId)],
    customFields
  };
}

export function buildLeverCardUpdatePayload({ phone, unit, objective, investment, customFields }) {
  return {
    fields: ["Description", "MonetaryAmount", "CustomFields"],
    description: buildLeverDescription({ phone, unit, objective, investment }),
    monetaryAmount: investment.monetaryAmount,
    customFields
  };
}

export async function findLeverContactByPhone(
  phone,
  { config = getLeverConfig(), fetcher = fetch } = {}
) {
  const normalizedPhone = normalizeBrazilianMobile(phone);
  const url = `${config.baseUrl}/core/v1/contact/filter`;

  for (const status of ["ACTIVE", "ARCHIVED", "BLOCKED"]) {
    const payload = await requestLeverJson(url, {
      method: "POST",
      body: {
        phoneNumber: normalizedPhone,
        status,
        pageNumber: 1,
        pageSize: 10
      },
      config,
      fetcher
    });
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const contact = items.find((item) => {
      const itemPhone = item?.phoneNumber || item?.phonenumber || "";
      return normalizeBrazilianMobile(itemPhone) === normalizedPhone;
    });
    if (contact?.id) return contact;
  }

  return null;
}

export async function createLeverContact(
  lead,
  { config = getLeverConfig(), fetcher = fetch } = {}
) {
  const payload = await requestLeverJson(`${config.baseUrl}/core/v1/contact`, {
    method: "POST",
    body: buildLeverContactPayload(lead),
    config,
    fetcher,
    retries: 0
  });
  const contact = getResponseEntity(payload);
  if (!contact?.id) throw new Error("A Lever não retornou o identificador do contato.");
  return contact;
}

export async function ensureLeverContact(
  lead,
  { config = getLeverConfig(), fetcher = fetch } = {}
) {
  const existingContact = await findLeverContactByPhone(lead.phone, { config, fetcher });
  if (existingContact) return existingContact;

  try {
    return await createLeverContact(lead, { config, fetcher });
  } catch (error) {
    const contactCreatedByAnotherRequest = await findLeverContactByPhone(lead.phone, {
      config,
      fetcher
    });
    if (contactCreatedByAnotherRequest) return contactCreatedByAnotherRequest;
    throw error;
  }
}

export async function createLeverCard(
  lead,
  { config = getLeverConfig(), fetcher = fetch, now = () => new Date() } = {}
) {
  const fields = await listLeverPanelCustomFields({ config, fetcher });
  const customFields = buildLeverCustomFields(fields, { entryDate: now() });
  const payload = await requestLeverJson(`${config.baseUrl}/crm/v2/panel/card`, {
    method: "POST",
    body: buildLeverCardPayload({ ...lead, customFields }, config),
    config,
    fetcher
  });
  return getResponseEntity(payload);
}

export async function getLeverCard(cardId, { config = getLeverConfig(), fetcher = fetch } = {}) {
  const payload = await requestLeverJson(
    `${config.baseUrl}/crm/v2/panel/card/${encodeURIComponent(cardId)}`,
    { config, fetcher }
  );
  return getResponseEntity(payload);
}

export async function updateLeverCard(
  cardId,
  details,
  { config = getLeverConfig(), fetcher = fetch, now = () => new Date() } = {}
) {
  const [card, fields] = await Promise.all([
    getLeverCard(cardId, { config, fetcher }),
    listLeverPanelCustomFields({ config, fetcher })
  ]);
  const samePanel = String(card?.panelId || "") === String(config.panelId);
  const sameContact = Array.isArray(card?.contactIds)
    && card.contactIds.some((contactId) => String(contactId) === String(details.contactId));
  if (!samePanel || !sameContact) throw new Error("O card informado não pertence a este contato e painel.");

  const entryDate = card?.createdAt ? new Date(card.createdAt) : now();
  const customFields = buildLeverCustomFields(fields, {
    unit: details.unit,
    objective: details.objective,
    entryDate,
    includeUnit: true,
    includeObjective: true
  });
  const payload = await requestLeverJson(
    `${config.baseUrl}/crm/v3/panel/card/${encodeURIComponent(cardId)}`,
    {
      method: "PUT",
      body: buildLeverCardUpdatePayload({ ...details, customFields }),
      config,
      fetcher
    }
  );
  return getResponseEntity(payload);
}

export async function captureLeverLead(
  lead,
  { config = getLeverConfig(), fetcher = fetch, now = () => new Date() } = {}
) {
  const contact = await ensureLeverContact(lead, { config, fetcher });
  const card = await createLeverCard(
    { ...lead, contactId: contact.id },
    { config, fetcher, now }
  );
  return { contact, card };
}

export async function captureLeverDetails(
  lead,
  { config = getLeverConfig(), fetcher = fetch, now = () => new Date() } = {}
) {
  const contact = await ensureLeverContact(lead, { config, fetcher });
  const unit = getUnit(lead.unitCode);
  const objective = getObjective(lead.objectiveId);
  const investment = getInvestment(lead.investmentId);
  const card = await updateLeverCard(
    lead.cardId,
    { phone: lead.phone, contactId: contact.id, unit, objective, investment },
    { config, fetcher, now }
  );
  return { contact, card };
}

function validateLead(payload) {
  if (!payload || typeof payload !== "object") return "Payload inválido.";
  if (!payload.name || String(payload.name).trim().length < 2) return "Nome inválido.";
  return validateMobile(payload.phone) || "";
}

function validateDetails(payload) {
  if (!payload.cardId) return "";
  if (!CARD_ID_PATTERN.test(String(payload.cardId))) return "Card inválido.";
  if (!getUnit(payload.unitCode)) return "Unidade inválida.";
  if (!getObjective(payload.objectiveId)) return "Objetivo inválido.";
  if (!getInvestment(payload.investmentId)) return "Investimento inválido.";
  return "";
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ["POST"])) return;

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { message: "JSON inválido." });
    return;
  }

  const validation = validateLead(payload) || validateDetails(payload);
  if (validation) {
    sendJson(res, 400, { message: validation });
    return;
  }

  try {
    const lead = {
      name: String(payload.name).trim(),
      phone: normalizeBrazilianMobile(payload.phone)
    };
    const result = payload.cardId
      ? await captureLeverDetails({
        ...lead,
        cardId: String(payload.cardId),
        unitCode: Number(payload.unitCode),
        objectiveId: payload.objectiveId,
        investmentId: payload.investmentId
      })
      : await captureLeverLead(lead);
    sendJson(res, payload.cardId ? 200 : 201, {
      ok: true,
      contactId: result.contact?.id || "",
      cardId: result.card?.id || payload.cardId || ""
    });
  } catch (error) {
    console.error("Falha ao sincronizar o card da Lever.", error);
    sendJson(res, 502, {
      ok: false,
      message: "Não foi possível registrar o contato no painel agora."
    });
  }
}
