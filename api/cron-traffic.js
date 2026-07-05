const HIGHWAYS = [
  { road: 'I-95',  name: 'I-95 (Delaware Expressway)',       bbox: [-75.14, 39.88, -75.03, 40.08],     namePattern: /I-?95|Delaware\s*Exp/i },
  { road: 'I-76',  name: 'I-76 (Schuylkill Expressway)',     bbox: [-75.40, 39.94, -75.17, 40.10],     namePattern: /I-?76|Schuylkill\s*Exp/i },
  { road: 'I-676', name: 'I-676 (Vine St Expressway)',       bbox: [-75.165, 39.955, -75.145, 39.965], namePattern: /I-?676|Vine\s*St\s*Exp/i },
  { road: 'US-30', name: 'US-30 (City Ave / Lancaster Ave)', bbox: [-75.24, 39.99, -75.19, 40.03],     namePattern: /US-?30\b|City\s*Ave|Lancaster\s*Ave/i },
  { road: 'I-476', name: 'I-476 (Blue Route)',               bbox: [-75.36, 39.90, -75.30, 40.10],     namePattern: /I-?476\b/i },
];

const MPS_TO_MPH = 2.23694;

async function fetchFlow(bbox) {
  const [west, south, east, north] = bbox;
  const url = `https://data.traffic.hereapi.com/v7/flow?in=bbox:${west},${south},${east},${north}&locationReferencing=none&apiKey=${process.env.HERE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HERE flow request failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

function aggregate(results, namePattern) {
  const highwayLinks = results.filter(r => namePattern.test(r.location?.description || ''));
  let lenSum = 0, speedLenSum = 0, jamSum = 0, n = 0;
  for (const r of highwayLinks) {
    const len = r.location?.length;
    const flow = r.currentFlow;
    if (!len || !flow || flow.speed == null) continue;
    lenSum += len;
    speedLenSum += flow.speed * len;
    jamSum += (flow.jamFactor ?? 0);
    n++;
  }
  if (!n || lenSum === 0) return null;

  const avgSpeedMph = (speedLenSum / lenSum) * MPS_TO_MPH;

  return {
    current_speed_mph: Math.round(avgSpeedMph * 10) / 10,
    jam_factor:         Math.round((jamSum / n) * 10) / 10,
    sample_count:       n,
  };
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const rows = [];
    for (const hwy of HIGHWAYS) {
      try {
        const results = await fetchFlow(hwy.bbox);
        const agg = aggregate(results, hwy.namePattern);
        if (agg) rows.push({ road: hwy.road, name: hwy.name, ...agg, updated_at: new Date().toISOString() });
      } catch (e) {
        console.warn(`[cron-traffic] ${hwy.road} failed:`, e.message);
      }
    }

    if (!rows.length) {
      return res.status(200).json({ ok: true, written: 0 });
    }

    const upsertRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/traffic_snapshot?on_conflict=road`,
      {
        method: 'POST',
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows),
      }
    );
    if (!upsertRes.ok) throw new Error(`Supabase upsert failed: HTTP ${upsertRes.status}`);

    res.status(200).json({ ok: true, written: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
