let pool;

export function databaseConnectionString(value) {
  const url = new URL(value);
  // node-postgres 8 currently treats sslmode=require as verify-full. Supabase's
  // shared pooler uses libpq's encrypted-without-CA-verification semantics for
  // this mode, which pg enables explicitly with uselibpqcompat.
  if (url.searchParams.get("sslmode") === "require" && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
}

async function query(sql, params = []) {
  if (!process.env.DATABASE_URL) throw new Error("Banco de pedidos não configurado.");
  if (!pool) {
    const { default: pg } = await import("pg");
    pool = new pg.Pool({ connectionString: databaseConnectionString(process.env.DATABASE_URL), max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
    pool.on("error", () => console.error("Conexão de pedidos interrompida."));
  }
  try {
    return await pool.query(sql, params);
  } catch (error) {
    // Log only diagnostic identifiers. Connection strings and credentials must never reach runtime logs.
    console.error("Consulta ao banco de pedidos falhou.", {
      code: typeof error?.code === "string" ? error.code : "unknown",
      name: typeof error?.name === "string" ? error.name : "Error"
    });
    throw error;
  }
}

export function createOrderStore(query) { return {
  async create(order) {
    const result = await query(`INSERT INTO drenesse_orders (id, access_token_hash, payload, amount_cents)
      VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING RETURNING *`,
    [order.id, order.access_token_hash, order.payload, order.amount_cents]);
    return result.rows[0] || null;
  },
  async get(id) {
    return (await query("SELECT * FROM drenesse_orders WHERE id = $1", [id])).rows[0] || null;
  },
  async forCheckout(id, reference) {
    return (await query(`SELECT * FROM drenesse_orders WHERE checkout_id = $1
      OR (checkout_id IS NULL AND id::text = $2) LIMIT 1`, [id, reference || ""])).rows[0] || null;
  },
  async update(id, changes, expectedStatuses) {
    const allowed = new Set(["status", "checkout_id", "checkout_url", "payment_id", "paid_at", "processing_at", "lead_code", "booking_code", "attention_reason"]);
    const entries = Object.entries(changes);
    if (!entries.length || entries.some(([key]) => !allowed.has(key))) throw new Error("Atualização de pedido inválida.");
    const assignments = entries.map(([key], i) => `${key} = $${i + 2}`).join(", ");
    const values = [id, ...entries.map(([, value]) => value), expectedStatuses];
    const result = await query(`UPDATE drenesse_orders SET ${assignments}, updated_at = now()
      WHERE id = $1 AND status = ANY($${values.length}::text[]) RETURNING *`, values);
    return result.rows[0] || null;
  },
  async receiveEvent(event) {
    await query(`INSERT INTO drenesse_payment_events (id, event_type, checkout_id) VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING`, [event.id, event.event, event.checkout.id]);
  },
  async completeEvent(id) {
    await query("UPDATE drenesse_payment_events SET processed_at = now() WHERE id = $1", [id]);
  }
}; }

export const orderStore = createOrderStore(query);
