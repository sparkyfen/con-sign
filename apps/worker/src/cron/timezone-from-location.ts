/**
 * Derive an IANA timezone from the free-form `con.location` string the
 * ICS feed gives us. Best-effort: return null when we can't tell, and
 * the rest of the system already handles a null timezone (panel
 * renderer omits the clock and falls back to UTC for DAY rollover).
 *
 * Format observation (n≈200 cons from furrycons.com): the last
 * comma-separated token is either a US state abbreviation or a
 * country name. The token before it can be useful for disambiguating
 * multi-timezone countries (Australia, Canada, Brazil, ...). The
 * earlier tokens are venue/street/city and we don't need them.
 *
 * Lookup tables intentionally small: high-frequency convention
 * locations only. Cons with a tail we don't recognize stay null;
 * next sync gets another shot once the table grows.
 */

const US_STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix', // no DST
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DE: 'America/New_York',
  DC: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  ID: 'America/Boise',
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/Detroit',
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago',
  NV: 'America/Los_Angeles',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver',
};

/** Single-timezone (or de-facto single) countries by long name. */
const COUNTRY_TZ: Record<string, string> = {
  argentina: 'America/Argentina/Buenos_Aires',
  austria: 'Europe/Vienna',
  belgium: 'Europe/Brussels',
  chile: 'America/Santiago',
  china: 'Asia/Shanghai', // officially one tz nationwide
  'czech republic': 'Europe/Prague',
  czechia: 'Europe/Prague',
  denmark: 'Europe/Copenhagen',
  finland: 'Europe/Helsinki',
  france: 'Europe/Paris', // mainland; overseas territories not handled
  germany: 'Europe/Berlin',
  hungary: 'Europe/Budapest',
  ireland: 'Europe/Dublin',
  italy: 'Europe/Rome',
  japan: 'Asia/Tokyo',
  malaysia: 'Asia/Kuala_Lumpur',
  mexico: 'America/Mexico_City', // mainland; northern border zones differ
  netherlands: 'Europe/Amsterdam',
  'new zealand': 'Pacific/Auckland',
  norway: 'Europe/Oslo',
  poland: 'Europe/Warsaw',
  portugal: 'Europe/Lisbon',
  singapore: 'Asia/Singapore',
  slovakia: 'Europe/Bratislava',
  slovenia: 'Europe/Ljubljana',
  'south korea': 'Asia/Seoul',
  korea: 'Asia/Seoul',
  spain: 'Europe/Madrid',
  sweden: 'Europe/Stockholm',
  switzerland: 'Europe/Zurich',
  taiwan: 'Asia/Taipei',
  thailand: 'Asia/Bangkok',
  uk: 'Europe/London',
  'united kingdom': 'Europe/London',
  britain: 'Europe/London',
};

/**
 * For multi-tz countries, look at the *second-to-last* token (usually
 * a state/province/region) to disambiguate. Keys are lowercase trimmed.
 */
const REGIONAL_TZ: Record<string, Record<string, string>> = {
  australia: {
    nsw: 'Australia/Sydney',
    'new south wales': 'Australia/Sydney',
    victoria: 'Australia/Melbourne',
    vic: 'Australia/Melbourne',
    queensland: 'Australia/Brisbane',
    qld: 'Australia/Brisbane',
    'south australia': 'Australia/Adelaide',
    sa: 'Australia/Adelaide',
    'western australia': 'Australia/Perth',
    wa: 'Australia/Perth',
    tasmania: 'Australia/Hobart',
    tas: 'Australia/Hobart',
    act: 'Australia/Sydney',
  },
  canada: {
    bc: 'America/Vancouver',
    'british columbia': 'America/Vancouver',
    ab: 'America/Edmonton',
    alberta: 'America/Edmonton',
    sk: 'America/Regina',
    saskatchewan: 'America/Regina',
    mb: 'America/Winnipeg',
    manitoba: 'America/Winnipeg',
    on: 'America/Toronto',
    ontario: 'America/Toronto',
    qc: 'America/Toronto',
    quebec: 'America/Toronto',
    'québec': 'America/Toronto',
    nb: 'America/Halifax',
    'new brunswick': 'America/Halifax',
    ns: 'America/Halifax',
    'nova scotia': 'America/Halifax',
    pe: 'America/Halifax',
    nl: 'America/St_Johns',
    newfoundland: 'America/St_Johns',
    yt: 'America/Whitehorse',
    yukon: 'America/Whitehorse',
  },
  brazil: {
    sp: 'America/Sao_Paulo',
    'são paulo': 'America/Sao_Paulo',
    'sao paulo': 'America/Sao_Paulo',
    rj: 'America/Sao_Paulo',
    'rio de janeiro': 'America/Sao_Paulo',
    mg: 'America/Sao_Paulo',
    rs: 'America/Sao_Paulo',
    am: 'America/Manaus',
    amazonas: 'America/Manaus',
  },
};

/** Country default when regional lookup misses. */
const MULTI_TZ_COUNTRY_DEFAULT: Record<string, string> = {
  australia: 'Australia/Sydney',
  canada: 'America/Toronto',
  brazil: 'America/Sao_Paulo',
};

export function inferTimezoneFromLocation(location: string | null): string | null {
  if (!location) return null;
  const parts = location
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  const tail = parts[parts.length - 1]!;
  const secondLast = parts.length >= 2 ? parts[parts.length - 2]! : null;

  // US state code: 2 uppercase letters in the tail position.
  if (/^[A-Z]{2}$/.test(tail) && US_STATE_TZ[tail]) {
    return US_STATE_TZ[tail]!;
  }

  const tailNorm = tail.toLowerCase();
  const multiTzRegions = REGIONAL_TZ[tailNorm];
  if (multiTzRegions && secondLast) {
    const regionTz = multiTzRegions[secondLast.toLowerCase()];
    if (regionTz) return regionTz;
  }
  if (MULTI_TZ_COUNTRY_DEFAULT[tailNorm]) {
    return MULTI_TZ_COUNTRY_DEFAULT[tailNorm]!;
  }
  if (COUNTRY_TZ[tailNorm]) {
    return COUNTRY_TZ[tailNorm]!;
  }

  return null;
}
