import fs from "fs";

const ATLAS_BASE = "https://atlas.ripe.net/api/v2";

async function atlasFetch(url, { apiKey, method = "GET", body } = {}) {
  const headers = {
    "Accept": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Key ${apiKey}`;
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`RIPE Atlas HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function pickItalianProbes({ countryCode, probeCount }) {
  // Filter by country_code=IT (docs) :contentReference[oaicite:6]{index=6}
  const url = `${ATLAS_BASE}/probes/?country_code=${encodeURIComponent(countryCode)}&status=1&limit=${probeCount}`;
  const data = await atlasFetch(url);
  const ids = (data.results || []).map(p => p.id).slice(0, probeCount);
  if (ids.length < Math.min(10, probeCount)) {
    throw new Error(`Not enough active probes for ${countryCode}. Got ${ids.length}`);
  }
  return ids;
}

export async function ensureMeasurements({ apiKey, state, probeIds, httpTargets, pingTargets }) {
  state.atlas = state.atlas || {};
  state.atlas.measurements = state.atlas.measurements || {};

  const created = [];

  // Create HTTP measurements
  for (const t of httpTargets) {
    const key = `http:${t.id}`;
    if (!state.atlas.measurements[key]) {
      const payload = {
        definitions: [
          {
            type: "http",
            af: 4,
            target: t.url,
            description: `HTTP ${t.name}`
          }
        ],
        probes: [
          {
            type: "probes",
            value: probeIds.join(","),
            requested: probeIds.length
          }
        ],
        is_oneoff: true
      };

      const resp = await atlasFetch(`${ATLAS_BASE}/measurements/`, { apiKey, method: "POST", body: payload });
      // response has measurements array with IDs (create-measurements docs) :contentReference[oaicite:7]{index=7}
      const mid = resp.measurements?.[0];
      if (!mid) throw new Error(`Create HTTP measurement failed for ${t.id}: ${JSON.stringify(resp).slice(0, 200)}`);
      state.atlas.measurements[key] = mid;
      created.push({ key, id: mid });
    }
  }

  // Create PING measurements
  for (const t of pingTargets) {
    const key = `ping:${t.id}`;
    if (!state.atlas.measurements[key]) {
      const payload = {
        definitions: [
          {
            type: "ping",
            af: 4,
            target: t.host,
            description: `PING ${t.name}`
          }
        ],
        probes: [
          {
            type: "probes",
            value: probeIds.join(","),
            requested: probeIds.length
          }
        ],
        is_oneoff: true
      };

      const resp = await atlasFetch(`${ATLAS_BASE}/measurements/`, { apiKey, method: "POST", body: payload });
      const mid = resp.measurements?.[0];
      if (!mid) throw new Error(`Create PING measurement failed for ${t.id}: ${JSON.stringify(resp).slice(0, 200)}`);
      state.atlas.measurements[key] = mid;
      created.push({ key, id: mid });
    }
  }

  return created;
}

function parseHttpSuccess(result) {
  // Heuristic: consider success if we see HTTP status_code 2xx/3xx
  const r = result?.result;
  // RIPE Atlas HTTP result formats vary; keep robust and conservative :contentReference[oaicite:8]{index=8}
  const status = r?.status_code ?? r?.code ?? r?.status;
  if (typeof status === "number") return status >= 200 && status < 400;

  // Some results include "res" array entries with "status_code"
  if (Array.isArray(r?.res)) {
    const sc = r.res.find(x => typeof x?.status_code === "number")?.status_code;
    if (typeof sc === "number") return sc >= 200 && sc < 400;
  }
  return false;
}

function parsePingSuccess(result) {
  // Success if at least one RTT sample exists
  const r = result?.result;
  if (Array.isArray(r)) {
    return r.some(x => typeof x?.rtt === "number");
  }
  if (Array.isArray(r?.responses)) {
    return r.responses.some(x => typeof x?.rtt === "number");
  }
  return false;
}

export async function latestResults({ measurementId, probeIds }) {
  // Latest endpoint docs :contentReference[oaicite:9]{index=9}
  const url = `${ATLAS_BASE}/measurements/${measurementId}/latest/?probe_ids=${probeIds.join(",")}`;
  return atlasFetch(url);
}

export async function evaluateAtlas({ apiKey, state, cfg }) {
  const probeIds = await pickItalianProbes({
    countryCode: cfg.countryCode,
    probeCount: cfg.probeCount
  });

  // Ensure one-off measurements exist in state; if missing, create them once
  await ensureMeasurements({
    apiKey,
    state,
    probeIds,
    httpTargets: cfg.targets,
    pingTargets: cfg.pingTargets
  });

  // Evaluate HTTP targets
  const httpStatus = {};
  for (const t of cfg.targets) {
    const mid = state.atlas.measurements[`http:${t.id}`];
    const results = await latestResults({ measurementId: mid, probeIds });

    const ok = results.filter(parseHttpSuccess).length;
    const fail = results.length - ok;
    const ratio = results.length ? fail / results.length : 0;

    httpStatus[t.id] = { ok, fail, total: results.length, failRatio: ratio };
  }

  // Evaluate PING targets (optional insight)
  const pingStatus = {};
  for (const t of cfg.pingTargets) {
    const mid = state.atlas.measurements[`ping:${t.id}`];
    const results = await latestResults({ measurementId: mid, probeIds });

    const ok = results.filter(parsePingSuccess).length;
    const fail = results.length - ok;
    const ratio = results.length ? fail / results.length : 0;

    pingStatus[t.id] = { ok, fail, total: results.length, failRatio: ratio };
  }

  // Incident if any HTTP target fails above threshold
  const incidentTargets = Object.entries(httpStatus)
    .filter(([, v]) => v.failRatio >= cfg.httpFailRatioThreshold)
    .map(([id]) => id);

  return {
    probeIds,
    httpStatus,
    pingStatus,
    incident: incidentTargets.length > 0,
    incidentTargets
  };
}
