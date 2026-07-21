// Proxies telemetry writes through the service-role key. The anon key used client-side is
// SELECT-only (see supabase/migrations/*_lock_down_anon_to_select_only.sql) — every write this
// app makes now goes through here instead, same client-secret-vs-server-secret separation
// already applied to HERE/PennDOT/Ticketmaster.
const ALLOWED_TABLES = new Set(['condition_snapshots', 'sfd_telemetry', 'aqi_telemetry']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { table, rows } = req.body || {};
  if (!ALLOWED_TABLES.has(table)) {
    return res.status(400).json({ error: 'Unknown or disallowed table' });
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows must be a non-empty array' });
  }
  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(rows),
    });
    if (!response.ok) throw new Error(`Supabase insert failed: HTTP ${response.status}`);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
