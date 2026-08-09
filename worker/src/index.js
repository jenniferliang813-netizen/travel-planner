const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
};

let tokenCache = null;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) {
    mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mismatch === 0;
}

export function isAuthorized(request, expectedKey) {
  if (!expectedKey) return false;
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key");
  const auth = request.headers.get("authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const suppliedKey = match?.[1] || queryKey || "";
  return safeEqual(suppliedKey, expectedKey);
}

export function decodeFirestoreValue(value) {
  if (value == null || typeof value !== "object") return value;
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("arrayValue" in value) {
    return (value.arrayValue.values || []).map(decodeFirestoreValue);
  }
  if ("mapValue" in value) {
    return decodeFirestoreFields(value.mapValue.fields || {});
  }
  return null;
}

export function decodeFirestoreFields(fields) {
  return Object.fromEntries(
    Object.entries(fields || {}).map(([key, value]) => [key, decodeFirestoreValue(value)]),
  );
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function orderOf(value) {
  const n = Number(value?.order);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function entriesInOrder(record) {
  return Object.entries(record || {}).sort(([, left], [, right]) => {
    const byOrder = orderOf(left) - orderOf(right);
    if (byOrder !== 0) return byOrder;
    return cleanText(left?.name || left?.label).localeCompare(cleanText(right?.name || right?.label), "zh-Hant");
  });
}

function cleanSegment(segment) {
  if (!segment || typeof segment !== "object") return null;
  const output = {};
  for (const key of ["label", "no", "from", "fromT", "dep", "to", "toT", "arr"]) {
    const value = cleanText(segment[key]);
    if (value) output[key] = value;
  }
  return Object.keys(output).length ? output : null;
}

function cleanFlights(pax) {
  return entriesInOrder(pax).map(([, person]) => ({
    name: cleanText(person.name),
    outbound: cleanSegment(person.ob),
    inbound: cleanSegment(person.ib),
    additionalLegs: entriesInOrder(person.legs)
      .map(([, leg]) => cleanSegment(leg))
      .filter(Boolean),
  })).filter((person) => person.name);
}

function cleanDays(days) {
  return Object.entries(days || {}).map(([id, day]) => ({
    id,
    day: Number(day.n) || null,
    date: cleanText(day.date),
    title: cleanText(day.title),
    plan: cleanText(day.plan),
    transport: cleanText(day.transport),
    lodging: cleanText(day.lodging),
    places: Array.isArray(day.spots) ? day.spots.map(cleanText).filter(Boolean) : [],
  })).sort((left, right) => (left.day ?? 999) - (right.day ?? 999));
}

function cleanSchedule(sched, days) {
  const dayOrder = new Map(days.map((day) => [day.id, day.day ?? 999]));
  return Object.entries(sched || {}).map(([id, item]) => ({
    id,
    dayId: cleanText(item.dayId),
    time: cleanText(item.time),
    activity: cleanText(item.act),
    duration: cleanText(item.stay),
    place: cleanText(item.place),
    transport: cleanText(item.trans),
    note: cleanText(item.note),
  })).sort((left, right) => {
    const byDay = (dayOrder.get(left.dayId) ?? 999) - (dayOrder.get(right.dayId) ?? 999);
    if (byDay !== 0) return byDay;
    const byTime = left.time.localeCompare(right.time);
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
}

function cleanRoute(route) {
  if (!Array.isArray(route)) return [];
  return route.map((point) => ({
    name: cleanText(point.name),
    lat: Number(point.lat),
    lng: Number(point.lng),
    days: cleanText(point.d),
    travelFromPrevious: cleanText(point.t),
    optional: Boolean(point.side),
    flight: Boolean(point.fly),
  })).filter((point) => point.name && Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function cleanShopping(shopping) {
  return entriesInOrder(shopping).map(([, item]) => ({
    name: cleanText(item.name),
    note: cleanText(item.note),
    purchased: Boolean(item.done),
  })).filter((item) => item.name);
}

export function toPublicTrip(tripId, trip, sourceUpdatedAt = null) {
  const days = cleanDays(trip.days);
  return {
    schemaVersion: 1,
    readOnly: true,
    tripId,
    generatedAt: new Date().toISOString(),
    sourceUpdatedAt,
    trip: {
      name: cleanText(trip.name),
      destination: cleanText(trip.destination),
      startDate: cleanText(trip.startDate),
      endDate: cleanText(trip.endDate),
      travelers: Array.isArray(trip.members) ? trip.members.map(cleanText).filter(Boolean) : [],
      flights: cleanFlights(trip.pax),
      days,
      schedule: cleanSchedule(trip.sched, days),
      route: cleanRoute(trip.route),
      shopping: cleanShopping(trip.shopping),
    },
  };
}

async function getFirebaseIdToken(env) {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) return tokenCache.idToken;

  const response = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: env.FIREBASE_REFRESH_TOKEN,
      }),
    },
  );
  if (!response.ok) throw new Error("Firebase authentication failed");
  const data = await response.json();
  tokenCache = {
    idToken: data.id_token,
    expiresAt: now + Number(data.expires_in || 3600) * 1000,
  };
  return tokenCache.idToken;
}

async function fetchTrip(tripId, env) {
  const idToken = await getFirebaseIdToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/trips/${encodeURIComponent(tripId)}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${idToken}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Firestore read failed");
  const document = await response.json();
  return {
    trip: decodeFirestoreFields(document.fields || {}),
    updateTime: document.updateTime || null,
  };
}

function allowedTripIds(env) {
  return new Set(String(env.ALLOWED_TRIP_IDS || "").split(",").map((id) => id.trim()).filter(Boolean));
}

export async function handleRequest(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return json({ ok: true, service: "travel-planner-readonly-api", schemaVersion: 1 });
  }

  const match = url.pathname.match(/^\/trip\/([A-Za-z0-9_-]+)$/);
  if (!match) return json({ error: "not_found" }, 404);
  if (!isAuthorized(request, env.READ_KEY)) return json({ error: "unauthorized" }, 401);

  const tripId = match[1];
  if (!allowedTripIds(env).has(tripId)) return json({ error: "not_found" }, 404);

  try {
    const result = await fetchTrip(tripId, env);
    if (!result) return json({ error: "not_found" }, 404);
    return json(toPublicTrip(tripId, result.trip, result.updateTime));
  } catch (error) {
    console.error("Readonly trip fetch failed", error?.message || error);
    return json({ error: "upstream_unavailable" }, 503);
  }
}

export default {
  fetch: handleRequest,
};
