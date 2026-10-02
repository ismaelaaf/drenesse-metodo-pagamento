CREATE TABLE IF NOT EXISTS drenesse_orders (
  id uuid PRIMARY KEY,
  access_token_hash text NOT NULL,
  payload jsonb NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'creating' CHECK (status IN (
    'creating', 'pending', 'paid', 'processing', 'confirmed', 'needs_attention',
    'cancelled', 'expired', 'setup_failed', 'setup_unknown'
  )),
  checkout_id text UNIQUE,
  checkout_url text,
  payment_id text UNIQUE,
  paid_at timestamptz,
  processing_at timestamptz,
  lead_code text,
  booking_code text,
  attention_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drenesse_payment_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  checkout_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS drenesse_orders_status_idx ON drenesse_orders(status, updated_at);
-- These are server-only tables. Do not expose orders or webhook events to browser clients.
ALTER TABLE drenesse_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE drenesse_payment_events ENABLE ROW LEVEL SECURITY;
