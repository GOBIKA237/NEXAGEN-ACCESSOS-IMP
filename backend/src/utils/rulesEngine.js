import { pool } from '../config/db.js';

export async function scoreLogin({ userId, deviceFingerprint, loginEventId, geoLat, geoLon, createdAt }) {
  let score = 0;

  const { rows: recentFails } = await pool.query(
    `SELECT COUNT(*) FROM login_events
     WHERE user_id = $1 AND success = false AND created_at > NOW() - INTERVAL '2 minutes'`,
    [userId]
  );
  if (parseInt(recentFails[0].count, 10) >= 5) score += 50;

  const { rows: knownDevice } = await pool.query(
    `SELECT 1 FROM login_events WHERE user_id = $1 AND device_fingerprint = $2 LIMIT 1`,
    [userId, deviceFingerprint]
  );
  if (knownDevice.length === 0) score += 30;

  const hour = new Date().getHours();
  if (hour >= 0 && hour < 5) score += 20;

  // Impossible-travel check. Only runs if the caller has geo data to give us —
  // see note above checkImpossibleTravel() for why this is optional-in.
  if (loginEventId != null && geoLat != null && geoLon != null) {
    const travel = await checkImpossibleTravel(userId, {
      id: loginEventId,
      geoLat,
      geoLon,
      createdAt: createdAt || new Date(),
    });
    if (travel.flagged) score += 40;
  }

  return Math.min(score, 100);
}

// --- Alerts support -------------------------------------------------------
//
// scoreLogin() intentionally keeps returning a plain number: auth.routes.js
// (Backend Dev 1's file) does `const riskScore = await scoreLogin(...)` and
// writes it straight into the integer `risk_score` column, so changing the
// return shape there would silently corrupt that column. Instead, for the
// admin alerts feed we recompute *which* rule(s) fired for an already-stored
// login_events row, using that row's own data.
//
// NOTE: this deliberately does NOT reproduce a quirk in scoreLogin() above —
// auth.routes.js inserts the login_events row *before* calling scoreLogin(),
// so the "known device" query there always finds the row it just inserted
// and the +30 unrecognized-device signal can never actually fire today.
// Flagging this for whoever picks up rulesEngine.js next rather than
// changing scoreLogin()'s live scoring behavior in this change.
//
// Because of that, don't try to back out "which rules fired" from
// risk_score alone — 30 + 20 and a lone 50 both sum to 50, so the total
// is ambiguous. We recheck each signal directly instead.

const FAILED_ATTEMPTS_THRESHOLD = 5;
const FAILED_ATTEMPTS_WINDOW = '2 minutes';
const OFF_HOURS_START = 0; // midnight
const OFF_HOURS_END = 5; // 5am, exclusive
const IMPOSSIBLE_TRAVEL_KMH_THRESHOLD = 900;
const IMPOSSIBLE_TRAVEL_MIN_GAP_MINUTES = 1;

// --- Impossible travel -----------------------------------------------------
//
// INTEGRATION CONTRACT (for auth.routes.js / alerts.routes.js, since I'm only
// editing this file):
//   - login_events needs geo_lat, geo_lon, geo_city columns (migration 005).
//   - auth.routes.js: the ip-api.com lookup + UPDATE ... SET geo_lat/geo_lon/
//     geo_city has to happen and be awaited BEFORE calling scoreLogin(), and
//     scoreLogin() now needs { loginEventId, geoLat, geoLon, createdAt } added
//     to its call. If geo lookup fails/times out, just don't pass geoLat/
//     geoLon (or pass null) — scoreLogin() skips the check entirely rather
//     than erroring, same "never block login" spirit as the geo fetch itself.
//   - alerts.routes.js: the SELECT feeding explainRiskSignals() needs to also
//     pull geo_lat, geo_lon, geo_city and pass them through as geoLat, geoLon,
//     geoCity.
//
// Haversine distance in km between two lat/lon points.
function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compare a login event's geo location against the user's most recent prior
 * geolocated login. Flags if implied speed exceeds the threshold.
 * @param {number} userId
 * @param {{ id: number, geoLat: number, geoLon: number, createdAt: string|Date }} currentLoginEvent
 * @returns {Promise<{ flagged: boolean, speedKmh?: number, fromCity?: string, toCity?: string }>}
 */
export async function checkImpossibleTravel(userId, currentLoginEvent) {
  const { id, geoLat, geoLon, createdAt } = currentLoginEvent;

  if (geoLat == null || geoLon == null) return { flagged: false };

  const { rows: prevRows } = await pool.query(
    `SELECT geo_lat, geo_lon, geo_city, created_at
     FROM login_events
     WHERE user_id = $1
       AND id != $2
       AND geo_lat IS NOT NULL
       AND geo_lon IS NOT NULL
       AND created_at < $3::timestamp
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, id, createdAt]
  );

  if (prevRows.length === 0) return { flagged: false }; // no prior geolocated login

  const prev = prevRows[0];
  const currentTime = new Date(createdAt).getTime();
  const prevTime = new Date(prev.created_at).getTime();
  const gapMinutes = (currentTime - prevTime) / 60000;

  if (gapMinutes < IMPOSSIBLE_TRAVEL_MIN_GAP_MINUTES) return { flagged: false };

  const distanceKm = haversineDistanceKm(
    parseFloat(prev.geo_lat),
    parseFloat(prev.geo_lon),
    parseFloat(geoLat),
    parseFloat(geoLon)
  );
  const hours = gapMinutes / 60;
  const speedKmh = distanceKm / hours;

  if (speedKmh > IMPOSSIBLE_TRAVEL_KMH_THRESHOLD) {
    return {
      flagged: true,
      speedKmh,
      fromCity: prev.geo_city,
      toCity: null, // filled in by caller (explainRiskSignals) which has current row's city
    };
  }

  return { flagged: false };
}

/**
 * Re-derive which risk signal(s) fired for a stored login_events row.
 * @param {{ id: number, userId: number, deviceFingerprint: string, createdAt: string|Date, geoLat?: number, geoLon?: number, geoCity?: string }} loginEvent
 * @returns {Promise<string[]>} human-readable reasons, e.g. ["5+ failed logins in 2 minutes"]
 */
export async function explainRiskSignals({
  id,
  userId,
  deviceFingerprint,
  createdAt,
  geoLat,
  geoLon,
  geoCity,
}) {
  const reasons = [];

  const { rows: recentFails } = await pool.query(
    `SELECT COUNT(*) FROM login_events
     WHERE user_id = $1 AND success = false
       AND created_at > $2::timestamp - INTERVAL '${FAILED_ATTEMPTS_WINDOW}'
       AND created_at <= $2::timestamp`,
    [userId, createdAt]
  );
  if (parseInt(recentFails[0].count, 10) >= FAILED_ATTEMPTS_THRESHOLD) {
    reasons.push('5+ failed logins in 2 minutes');
  }

  // Unlike scoreLogin()'s live check, exclude the event itself so a login's
  // very first appearance from a device actually counts as "unrecognized".
  const { rows: priorDevice } = await pool.query(
    `SELECT 1 FROM login_events
     WHERE user_id = $1 AND device_fingerprint = $2 AND id != $3
     LIMIT 1`,
    [userId, deviceFingerprint, id]
  );
  if (priorDevice.length === 0) {
    reasons.push('login from unrecognized device');
  }

  const hour = new Date(createdAt).getHours();
  if (hour >= OFF_HOURS_START && hour < OFF_HOURS_END) {
    reasons.push('login during off-hours (midnight–5am)');
  }

  if (geoLat != null && geoLon != null) {
    const travel = await checkImpossibleTravel(userId, { id, geoLat, geoLon, createdAt });
    if (travel.flagged) {
      const from = travel.fromCity || 'unknown location';
      const to = geoCity || 'unknown location';
      const speed = Math.round(travel.speedKmh);
      reasons.push(`impossible travel: ${from} → ${to} at ${speed}km/h`);
    }
  }

  return reasons;
}
