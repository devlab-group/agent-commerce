/**
 * Deterministic fake weather.
 *
 * The demo merchant API knows nothing about agents or payments — it is an
 * ordinary backend the gateway fronts. Weather is derived from a stable hash
 * of the city name so integration tests can assert exact values: no
 * randomness, and the only clock dependency (`observedAt`) is injectable.
 */

/** FNV-1a, 32-bit. Deterministic, dependency-free string hash. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const WEATHER_CONDITIONS = [
  'clear',
  'cloudy',
  'rain',
  'snow',
  'windy',
  'fog',
  'storm',
] as const;

export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number];

export interface WeatherReading {
  readonly city: string;
  readonly temperatureC: number;
  readonly condition: WeatherCondition;
  readonly humidityPercent: number;
  readonly windKph: number;
  readonly observedAt: string;
}

/** Deterministic weather for `city`, as of `now`. Free resource. */
export function getWeather(city: string, now: Date): WeatherReading {
  const normalized = city.trim().toLowerCase();
  const hash = hashString(normalized);

  const temperatureC = -10 + (hash % 45); // -10..34
  const condition = WEATHER_CONDITIONS[hash % WEATHER_CONDITIONS.length] ?? 'clear';
  const humidityPercent = 20 + ((hash >>> 8) % 71); // 20..90
  const windKph = (hash >>> 16) % 61; // 0..60

  return {
    city,
    temperatureC,
    condition,
    humidityPercent,
    windKph,
    observedAt: now.toISOString(),
  };
}
