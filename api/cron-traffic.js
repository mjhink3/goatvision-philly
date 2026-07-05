const HIGHWAYS = [
  { road: 'I-95',  name: 'I-95 (Delaware Expressway)',       bbox: [-75.14, 39.88, -75.03, 40.08],     namePattern: /I-?95|Delaware\s*Exp/i,        axisType: 'ns' },
  { road: 'I-76',  name: 'I-76 (Schuylkill Expressway)',     bbox: [-75.40, 39.94, -75.17, 40.10],     namePattern: /I-?76|Schuylkill\s*Exp/i,      axisType: 'ew' },
  { road: 'I-676', name: 'I-676 (Vine St Expressway)',       bbox: [-75.165, 39.955, -75.145, 39.965], namePattern: /I-?676|Vine\s*St\s*Exp/i,      axisType: 'ns' },
  { road: 'US-30', name: 'US-30 (City Ave / Lancaster Ave)', bbox: [-75.24, 39.99, -75.19, 40.03],     namePattern: /US-?30\b|City\s*Ave|Lancaster\s*Ave/i, axisType: 'ew' },
  { road: 'I-476', name: 'I-476 (Blue Route)',               bbox: [-75.36, 39.90, -75.30, 40.10],     namePattern: /I-?476\b/i,                    axisType: 'ns' },
];

const MPS_TO_MPH = 2.23694;

async function fetchFlow(bbox) {
  const [west, south, east, north] = bbox;
  const url = `https://data.traffic.hereapi.com/v7/flow?in=bbox:${west},${south},${east},${north}&locationReferencing=shape&apiKey=${process.env.HERE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HERE flow request failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const phi1 = toRad(lat1), phi2 = toRad(lat2), dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function linkBearing(r) {
  const linkSegs = r.location?.shape?.links || [];
  const allPoints = linkSegs.flatMap(l => l.points || []);
  if (allPoints.length < 2) return null;
  const first = allPoints[0], last = allPoints[allPoints.length - 1];
  return bearingDeg(first.lat, first.lng, last.lat, last.lng);
}

// Circular distance between two bearings (0-360), result in [0,180]
function circDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Axial mean: treats bearing and bearing+180 as the same axis (doubling-angle technique),
// so a highway's two opposing carriageways collapse onto one stable orientation estimate.
function computeAxis(bearings) {
  let sumSin = 0, sumCos = 0;
  for (const b of bearings) {
    const rad2 = (b * 2) * Math.PI / 180;
    sumSin += Math.sin(rad2);
    sumCos += Math.cos(rad2);
  }
  const meanRad2 = Math.atan2(sumSin, sumCos);
  return (((meanRad2 * 180 / Math.PI) / 2) % 180 + 180) % 180;
}

// Standard circular mean — valid within one direction group where bearings don't cancel out.
function meanBearing(bearings) {
  let sumSin = 0, sumCos = 0;
  for (const b of bearings) {
    const rad = b * Math.PI / 180;
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
  }
  return (Math.atan2(sumSin, sumCos) * 180 / Math.PI + 360) % 360;
}

function aggregateGroup(links) {
  let lenSum = 0, speedLenSum = 0, jamSum = 0, n = 0;
  for (const r of links) {
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

// Splits a highway's filtered links into two direction groups based on each link's own
// bearing relative to the highway's empirically-derived axis (not a hardcoded cardinal
// assumption — I-95 in Philly runs diagonally along the river, not true north-south).
function aggregateDirectional(results, hwy) {
  const highwayLinks = results.filter(r => hwy.namePattern.test(r.location?.description || ''));
  const withBearing = highwayLinks
    .map(r => ({ r, bearing: linkBearing(r) }))
    .filter(x => x.bearing != null);

  if (!withBearing.length) return [];

  const axis = computeAxis(withBearing.map(x => x.bearing));
  const groupA = [], groupB = [];
  for (const item of withBearing) {
    const distA = circDist(item.bearing, axis);
    const distB = circDist(item.bearing, (axis + 180) % 360);
    (distA <= distB ? groupA : groupB).push(item);
  }
  if (!groupA.length || !groupB.length) return [];

  const meanA = meanBearing(groupA.map(x => x.bearing));
  const meanB = meanBearing(groupB.map(x => x.bearing));

  let labelA, labelB;
  if (hwy.axisType === 'ns') {
    const aIsNorth = circDist(meanA, 0) < circDist(meanB, 0);
    labelA = aIsNorth ? 'N' : 'S';
    labelB = aIsNorth ? 'S' : 'N';
  } else {
    const aIsEast = circDist(meanA, 90) < circDist(meanB, 90);
    labelA = aIsEast ? 'E' : 'W';
    labelB = aIsEast ? 'W' : 'E';
  }

  const aggA = aggregateGroup(groupA.map(x => x.r));
  const aggB = aggregateGroup(groupB.map(x => x.r));

  const rows = [];
  if (aggA) rows.push({ direction: labelA, ...aggA });
  if (aggB) rows.push({ direction: labelB, ...aggB });
  return rows;
}

const DIR_NAME = { N: 'Northbound', S: 'Southbound', E: 'Eastbound', W: 'Westbound' };

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const rows = [];
    for (const hwy of HIGHWAYS) {
      try {
        const results = await fetchFlow(hwy.bbox);
        const dirRows = aggregateDirectional(results, hwy);
        for (const dr of dirRows) {
          rows.push({
            road: hwy.road,
            direction: dr.direction,
            name: `${hwy.name} (${DIR_NAME[dr.direction]})`,
            current_speed_mph: dr.current_speed_mph,
            jam_factor: dr.jam_factor,
            sample_count: dr.sample_count,
            updated_at: new Date().toISOString(),
          });
        }
      } catch (e) {
        console.warn(`[cron-traffic] ${hwy.road} failed:`, e.message);
      }
    }

    if (!rows.length) {
      return res.status(200).json({ ok: true, written: 0 });
    }

    const upsertRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/traffic_snapshot?on_conflict=road,direction`,
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
