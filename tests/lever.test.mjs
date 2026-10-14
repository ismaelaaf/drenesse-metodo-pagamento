import assert from "node:assert/strict";
import {
  buildLeverCardUpdatePayload,
  buildLeverCardPayload,
  buildLeverCustomFields,
  buildLeverContactPayload,
  captureLeverDetails,
  captureLeverLead,
  createLeverCard,
  getLeverConfig
} from "../api/capture-lead.js";
import { getInvestment, getObjective, getUnit } from "../src/lib/domain.js";

const STEP_RESGATAR = "ecfd754a-e880-4da1-8bac-ef8a14305a6b";
const STEP_FALHOU = "80189b0b-29b8-4169-9730-cad75b08dfed";
const STEP_LEAD_FRIO = "8455a328-8af7-41f5-923e-0167533753c3";
const STEP_AGENDADO = "4706f31a-feb2-4726-aea7-e0eaf57c7125";

const config = {
  token: "test-token",
  baseUrl: "https://api.app.leverconversas.com.br",
  panelId: "a3ee4cf3-291f-4c8f-8535-e3414642951a",
  stepId: "44586803-6791-41fd-b95a-826902688a25",
  restartStepIds: [STEP_RESGATAR, STEP_FALHOU, STEP_LEAD_FRIO]
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const isCardList = (url) => url.includes("/crm/v1/panel/card?");

const lead = { name: " Maria da Silva ", phone: "+55 (84) 9 8830-7853" };
const customFields = [
  {
    name: "Unidade",
    key: "field_unit",
    type: "SINGLESELECT",
    options: [
      { id: "unit-petropolis", name: "Drenesse Petrópolis" },
      { id: "unit-lagoa-nova", name: "Lagoa Nova" }
    ]
  },
  { name: "Data de entrada", key: "field_entry_date", type: "DATE" },
  { name: "Principal incômodo", key: "field_objective", type: "STRING" }
];

assert.deepEqual(buildLeverContactPayload(lead), {
  name: "Maria da Silva",
  phoneNumber: "+55|84988307853"
});

const cardPayload = buildLeverCardPayload(
  { ...lead, contactId: "contact-123" },
  config
);

assert.deepEqual(cardPayload, {
  title: "Maria da Silva",
  description: "WhatsApp: +55 (84) 9 8830-7853\nOrigem: Landing Método Drenesse",
  stepId: config.stepId,
  contactIds: ["contact-123"],
  customFields: {}
});

assert.deepEqual(
  buildLeverCustomFields(customFields, {
    unit: getUnit(2),
    objective: getObjective("flacidez"),
    entryDate: new Date("2026-10-13T15:00:00Z"),
    includeUnit: true,
    includeObjective: true
  }),
  {
    field_unit: "unit-lagoa-nova",
    field_entry_date: "2026-10-13",
    field_objective: "Flacidez"
  }
);

assert.deepEqual(
  buildLeverCardUpdatePayload({
    phone: lead.phone,
    unit: getUnit(2),
    objective: getObjective("flacidez"),
    investment: getInvestment("300-800"),
    customFields: { field_unit: "unit-lagoa-nova" }
  }),
  {
    fields: ["Description", "MonetaryAmount", "CustomFields"],
    description: "WhatsApp: +55 (84) 9 8830-7853\nOrigem: Landing Método Drenesse\nUnidade: Drenesse Lagoa Nova\nPrincipal incômodo: Flacidez\nInvestimento mensal: R$ 300 a R$ 800",
    monetaryAmount: 650,
    customFields: { field_unit: "unit-lagoa-nova" }
  }
);

assert.throws(
  () => buildLeverCardPayload(lead, config),
  /precisa estar vinculado a um contato/
);

{
  const calls = [];
  const result = await captureLeverLead(lead, {
    config,
    now: () => new Date("2026-10-13T15:00:00Z"),
    fetcher: async (url, request) => {
      calls.push({ url, request, body: request.body ? JSON.parse(request.body) : undefined });
      if (url.endsWith("/core/v1/contact/filter")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "existing-contact", phoneNumber: "+55|84988307853" }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (isCardList(url)) return json({ items: [], totalItems: 0 });
      if (url.includes(`/crm/v1/panel/${config.panelId}/custom-fields`)) {
        return new Response(JSON.stringify(customFields), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.endsWith("/crm/v2/panel/card")) {
        return new Response(JSON.stringify({ id: "card-existing" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(result.contact.id, "existing-contact");
  assert.equal(result.card.id, "card-existing");
  assert.equal(result.reused, false);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0].body, {
    phoneNumber: "84988307853",
    status: "ACTIVE",
    pageNumber: 1,
    pageSize: 10
  });
  const listUrl = new URL(calls[1].url);
  assert.equal(listUrl.pathname, "/crm/v1/panel/card");
  assert.equal(listUrl.searchParams.get("panelId"), config.panelId);
  assert.equal(listUrl.searchParams.get("contactId"), "existing-contact");
  assert.equal(calls[1].request.method, "GET");
  assert.equal(calls[2].request.method, "GET");
  assert.deepEqual(calls[3].body.contactIds, ["existing-contact"]);
  assert.deepEqual(calls[3].body.customFields, { field_entry_date: "2026-10-13" });
}

{
  const filterStatuses = [];
  let contactRequest;
  let cardRequest;
  const result = await captureLeverLead(lead, {
    config,
    now: () => new Date("2026-10-13T15:00:00Z"),
    fetcher: async (url, request) => {
      const body = request.body ? JSON.parse(request.body) : undefined;
      if (url.endsWith("/core/v1/contact/filter")) {
        filterStatuses.push(body.status);
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.endsWith("/core/v1/contact")) {
        contactRequest = body;
        return new Response(
          JSON.stringify({ id: "new-contact", phoneNumber: "+55|84988307853" }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (isCardList(url)) return json({ items: [] });
      if (url.includes(`/crm/v1/panel/${config.panelId}/custom-fields`)) {
        return new Response(JSON.stringify(customFields), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      if (url.endsWith("/crm/v2/panel/card")) {
        cardRequest = body;
        return new Response(JSON.stringify({ id: "card-new" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.deepEqual(filterStatuses, ["ACTIVE", "ARCHIVED", "BLOCKED"]);
  assert.deepEqual(contactRequest, {
    name: "Maria da Silva",
    phoneNumber: "+55|84988307853"
  });
  assert.deepEqual(cardRequest.contactIds, ["new-contact"]);
  assert.deepEqual(cardRequest.customFields, { field_entry_date: "2026-10-13" });
  assert.equal(result.contact.id, "new-contact");
  assert.equal(result.card.id, "card-new");
}

{
  let cardAttempts = 0;
  let receivedRequest;
  const card = await createLeverCard(
    { name: "Maria da Silva", phone: "84988307853", contactId: "contact-123" },
    {
      config,
      now: () => new Date("2026-10-13T15:00:00Z"),
      fetcher: async (url, request) => {
        if (url.includes(`/crm/v1/panel/${config.panelId}/custom-fields`)) {
          return new Response(JSON.stringify(customFields), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        cardAttempts += 1;
        receivedRequest = { url, request };
        if (cardAttempts === 1) return new Response("temporarily unavailable", { status: 503 });
        return new Response(JSON.stringify({ id: "card-123" }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
  );

  assert.equal(cardAttempts, 2);
  assert.equal(receivedRequest.url, "https://api.app.leverconversas.com.br/crm/v2/panel/card");
  assert.equal(receivedRequest.request.method, "POST");
  assert.equal(receivedRequest.request.headers.Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(receivedRequest.request.body).contactIds, ["contact-123"]);
  assert.equal(card.id, "card-123");
}

{
  let updateRequest;
  const cardId = "11111111-1111-4111-8111-111111111111";
  const result = await captureLeverDetails(
    {
      ...lead,
      cardId,
      unitCode: 2,
      objectiveId: "flacidez",
      investmentId: "300-800"
    },
    {
      config,
      now: () => new Date("2026-10-13T15:00:00Z"),
      fetcher: async (url, request) => {
        if (url.endsWith("/core/v1/contact/filter")) {
          return new Response(JSON.stringify({
            items: [{ id: "contact-123", phoneNumber: "+55|84988307853" }]
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes(`/crm/v1/panel/${config.panelId}/custom-fields`)) {
          return new Response(JSON.stringify(customFields), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (url.endsWith(`/crm/v2/panel/card/${cardId}`)) {
          return new Response(JSON.stringify({
            id: cardId,
            panelId: config.panelId,
            contactIds: ["contact-123"],
            createdAt: "2026-10-13T12:30:00Z"
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (url.endsWith(`/crm/v3/panel/card/${cardId}`)) {
          updateRequest = JSON.parse(request.body);
          return new Response(JSON.stringify({ id: cardId, ...updateRequest }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }
    }
  );

  assert.equal(result.card.id, cardId);
  assert.deepEqual(updateRequest.fields, ["Description", "MonetaryAmount", "CustomFields"]);
  assert.equal(updateRequest.monetaryAmount, 650);
  assert.deepEqual(updateRequest.customFields, {
    field_unit: "unit-lagoa-nova",
    field_entry_date: "2026-10-13",
    field_objective: "Flacidez"
  });
  assert.match(updateRequest.description, /Investimento mensal: R\$ 300 a R\$ 800/);
}

{
  // Lead que volta pela landing estando em Lead frio: reaproveita o card mais antigo e volta para o início.
  const calls = [];
  const result = await captureLeverLead(lead, {
    config,
    now: () => new Date("2026-10-14T15:30:00Z"),
    fetcher: async (url, request) => {
      const body = request.body ? JSON.parse(request.body) : undefined;
      calls.push({ url, method: request.method, body });
      if (url.endsWith("/core/v1/contact/filter")) {
        return json({ items: [{ id: "contact-123", phoneNumber: "+55|84988307853" }] });
      }
      if (isCardList(url)) {
        return json({
          items: [
            { id: "card-outro-contato", panelId: config.panelId, contactIds: ["contact-999"], stepId: STEP_LEAD_FRIO, createdAt: "2026-09-01T10:00:00Z" },
            { id: "card-arquivado", panelId: config.panelId, contactIds: ["contact-123"], stepId: STEP_LEAD_FRIO, archived: true, createdAt: "2026-09-15T10:00:00Z" },
            { id: "card-novo", panelId: config.panelId, contactIds: ["contact-123"], stepId: STEP_RESGATAR, createdAt: "2026-10-10T10:00:00Z" },
            { id: "card-antigo", panelId: config.panelId, contactIds: ["contact-123"], stepId: STEP_LEAD_FRIO, createdAt: "2026-10-01T10:00:00Z" }
          ]
        });
      }
      if (url.endsWith("/crm/v1/panel/card/card-antigo") && request.method === "PUT") return json({ id: "card-antigo" });
      if (url.endsWith("/crm/v1/panel/card/card-antigo/note")) return json({ id: "note-1" });
      throw new Error(`Unexpected URL: ${request.method} ${url}`);
    }
  });

  assert.equal(result.reused, true);
  assert.equal(result.card.id, "card-antigo");
  assert.equal(result.card.stepId, config.stepId);
  assert.ok(!calls.some((call) => call.url.endsWith("/crm/v2/panel/card")), "não pode criar card novo");
  const move = calls.find((call) => call.method === "PUT");
  assert.deepEqual(move.body, { fields: ["StepId"], stepId: config.stepId });
  const note = calls.find((call) => call.url.endsWith("/note"));
  assert.equal(note.body.text, "Lead voltou pela landing em 14/10/2026, 12:30. O card voltou para o início do funil.");
}

{
  // Card em Agendado: reaproveita sem mudar de fase, só anota.
  const calls = [];
  const result = await captureLeverLead(lead, {
    config,
    now: () => new Date("2026-10-14T15:30:00Z"),
    fetcher: async (url, request) => {
      calls.push({ url, method: request.method, body: request.body ? JSON.parse(request.body) : undefined });
      if (url.endsWith("/core/v1/contact/filter")) {
        return json({ items: [{ id: "contact-123", phoneNumber: "+55|84988307853" }] });
      }
      if (isCardList(url)) {
        return json({ items: [{ id: "card-agendado", panelId: config.panelId, contactIds: ["contact-123"], stepId: STEP_AGENDADO, createdAt: "2026-10-01T10:00:00Z" }] });
      }
      if (url.endsWith("/crm/v1/panel/card/card-agendado/note")) return json({ id: "note-1" });
      throw new Error(`Unexpected URL: ${request.method} ${url}`);
    }
  });

  assert.equal(result.reused, true);
  assert.equal(result.card.id, "card-agendado");
  assert.equal(result.card.stepId, STEP_AGENDADO);
  assert.ok(!calls.some((call) => call.method === "PUT"), "card em Agendado não muda de fase");
  assert.match(calls.find((call) => call.url.endsWith("/note")).body.text, /continuou na fase em que estava/);
}

{
  // Se a busca do card falhar, o lead não se perde: cria um card novo como antes.
  const originalError = console.error;
  console.error = () => {};
  let created = false;
  const result = await captureLeverLead(lead, {
    config,
    now: () => new Date("2026-10-14T15:30:00Z"),
    fetcher: async (url, request) => {
      if (url.endsWith("/core/v1/contact/filter")) {
        return json({ items: [{ id: "contact-123", phoneNumber: "+55|84988307853" }] });
      }
      if (isCardList(url)) return new Response("indisponível", { status: 503 });
      if (url.includes(`/crm/v1/panel/${config.panelId}/custom-fields`)) return json(customFields);
      if (url.endsWith("/crm/v2/panel/card")) {
        created = true;
        return json({ id: "card-criado" });
      }
      throw new Error(`Unexpected URL: ${request.method} ${url}`);
    }
  });
  console.error = originalError;

  assert.equal(created, true);
  assert.equal(result.reused, false);
  assert.equal(result.card.id, "card-criado");
}

{
  const previous = process.env.LEVER_RESTART_STEP_IDS;
  delete process.env.LEVER_RESTART_STEP_IDS;
  assert.deepEqual(getLeverConfig().restartStepIds, [STEP_RESGATAR, STEP_FALHOU, STEP_LEAD_FRIO]);
  process.env.LEVER_RESTART_STEP_IDS = " passo-a , passo-b ";
  assert.deepEqual(getLeverConfig().restartStepIds, ["passo-a", "passo-b"]);
  if (previous === undefined) delete process.env.LEVER_RESTART_STEP_IDS;
  else process.env.LEVER_RESTART_STEP_IDS = previous;
}

console.log("Lever contact and card capture tests passed.");
