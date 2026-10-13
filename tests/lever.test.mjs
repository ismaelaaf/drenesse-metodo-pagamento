import assert from "node:assert/strict";
import {
  buildLeverCardUpdatePayload,
  buildLeverCardPayload,
  buildLeverCustomFields,
  buildLeverContactPayload,
  captureLeverDetails,
  captureLeverLead,
  createLeverCard
} from "../api/capture-lead.js";
import { getInvestment, getObjective, getUnit } from "../src/lib/domain.js";

const config = {
  token: "test-token",
  baseUrl: "https://api.app.leverconversas.com.br",
  panelId: "a3ee4cf3-291f-4c8f-8535-e3414642951a",
  stepId: "44586803-6791-41fd-b95a-826902688a25"
};

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
    monetaryAmount: 300,
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
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].body, {
    phoneNumber: "84988307853",
    status: "ACTIVE",
    pageNumber: 1,
    pageSize: 10
  });
  assert.equal(calls[1].request.method, "GET");
  assert.deepEqual(calls[2].body.contactIds, ["existing-contact"]);
  assert.deepEqual(calls[2].body.customFields, { field_entry_date: "2026-10-13" });
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
  assert.equal(updateRequest.monetaryAmount, 300);
  assert.deepEqual(updateRequest.customFields, {
    field_unit: "unit-lagoa-nova",
    field_entry_date: "2026-10-13",
    field_objective: "Flacidez"
  });
  assert.match(updateRequest.description, /Investimento mensal: R\$ 300 a R\$ 800/);
}

console.log("Lever contact and card capture tests passed.");
