function loadState() {
  let raw = null;

  if (fs.existsSync(STATE_FILE)) {
    try {
      raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    } catch {
      raw = null;
    }
  }

  // default new schema
  const state = { incidents: {}, netblocks: {} };

  // if empty or invalid -> return defaults
  if (!raw || typeof raw !== "object") return state;

  // if already new schema -> merge & ensure objects
  if (raw.incidents && typeof raw.incidents === "object") state.incidents = raw.incidents;
  if (raw.netblocks && typeof raw.netblocks === "object") state.netblocks = raw.netblocks;

  // migration: old schema was { "ServiceName": true } or similar
  // move boolean flags into incidents map
  for (const [k, v] of Object.entries(raw)) {
    if (k === "incidents" || k === "netblocks") continue;
    if (v === true) {
      state.incidents[k] = { startedAt: new Date().toISOString(), migrated: true };
    }
  }

  return state;
}
