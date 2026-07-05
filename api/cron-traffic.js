const HIGHWAYS = [
  { road: 'I-95',  name: 'I-95 (Delaware Expressway)',       bbox: [-75.14, 39.88, -75.03, 40.08] },
  { road: 'I-76',  name: 'I-76 (Schuylkill Expressway)',     bbox: [-75.40, 39.94, -75.17, 40.10] },
  { road: 'I-676', name: 'I-676 (Vine St Expressway)',       bbox: [-75.165, 39.955, -75.145, 39.965] },
  { road: 'US-30', name: 'US-30 (City Ave / Lancaster Ave)', bbox: [-75.24, 39.99, -75.19, 40.03] },
  { road: 'I-476', name: 'I-476 (Blue Route)',               bbox: [-75.36, 39.90, -75.30, 40.10] },
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

function aggregate(results) {
  let lenSum = 0, speedLenSum = 0, freeFlowLenSum = 0, jamSum = 0, n = 0;
  for (const r of results) {
    const len = r.location?.length;
    const flow = r.currentFlow;
    if (!len || !flow || flow.speed == null || flow.freeFlow == null) continue;
    lenSum += len;
    speedLenSum += flow.speed * len;
    freeFlowLenSum += flow.freeFlow * len;
    jamSum += (flow.jamFactor ?? 0);
    n++;
  }
  if (!n || lenSum === 0) return null;

  const avgSpeedMph = (speedLenSum / lenSum) * MPS_TO_MPH;
  const avgFreeFlowMph = (freeFlowLenSum / lenSum) * MPS_TO_MPH;
  const miles = lenSum / 1609.34;

  return {
    current_speed_mph:   Math.round(avgSpeedMph * 10) / 10,
    free_flow_speed_mph: Math.round(avgFreeFlowMph * 10) / 10,
    jam_factor:          Math.round((jamSum / n) * 10) / 10,
    current_minutes:     Math.round((miles / avgSpeedMph) * 60),
    average_minutes:     Math.round((miles / avgFreeFlowMph) * 60),
    sample_count:        n,
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
        if (hwy.road === 'I-95' && results.length) {
          // TEMP DEBUG — evaluating whether shape-referenced links give a usable
          // directional signal and whether description text cleanly separates
          // highway links from cross streets. Remove after inspection.
          try {
            const [west, south, east, north] = hwy.bbox;
            const shapeUrl = `https://data.traffic.hereapi.com/v7/flow?in=bbox:${west},${south},${east},${north}&locationReferencing=shape&apiKey=${process.env.HERE_API_KEY}`;
            const shapeRes = await fetch(shapeUrl);
            const shapeData = await shapeRes.json();
            const sample = (shapeData.results || []).slice(0, 10).map(r => ({
              description: r.location?.description,
              length: r.location?.length,
              shape: r.location?.shape,
            }));
            console.log('[DEBUG-I95-SHAPE]', JSON.stringify(sample));
          } catch (e) {
            console.log('[DEBUG-I95-SHAPE-ERROR]', e.message);
          }
        }
        const agg = aggregate(results);
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
