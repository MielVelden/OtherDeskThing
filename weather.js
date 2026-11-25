'use strict';

// Weather from Open-Meteo (free, no API key). Defaults to Eindhoven.

const NAME = process.env.WEATHER_NAME || 'Eindhoven';
const LAT = process.env.WEATHER_LAT || '51.4416';
const LON = process.env.WEATHER_LON || '5.4697';
const TZ = process.env.WEATHER_TZ || 'Europe/Amsterdam';
const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 2 * 60 * 1000;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// WMO weather codes -> label + pixel icon name (see public/img/wx-*.png).
function describe(code, isDay) {
  const night = isDay === 0;
  if (code === 0) return { label: 'Clear', icon: night ? 'moon' : 'sun' };
  if (code === 1) return { label: 'Mostly clear', icon: night ? 'moon' : 'sun' };
  if (code === 2) return { label: 'Partly cloudy', icon: night ? 'partly-night' : 'partly' };
  if (code === 3) return { label: 'Overcast', icon: 'cloudy' };
  if (code === 45 || code === 48) return { label: 'Fog', icon: 'fog' };
  if (code >= 51 && code <= 57) return { label: 'Drizzle', icon: 'rain' };
  if (code >= 61 && code <= 67) return { label: code >= 65 ? 'Heavy rain' : 'Rain', icon: 'rain' };
  if (code >= 71 && code <= 77) return { label: 'Snow', icon: 'snow' };
  if (code >= 80 && code <= 82) return { label: 'Showers', icon: 'rain' };
  if (code === 85 || code === 86) return { label: 'Snow showers', icon: 'snow' };
  if (code >= 95) return { label: 'Thunderstorm', icon: 'thunder' };
  return { label: 'Unknown', icon: 'cloudy' };
}

function round(n) {
  return typeof n === 'number' ? Math.round(n) : null;
}

function url() {
  return 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: LAT,
    longitude: LON,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: TZ,
    forecast_days: '4',
    wind_speed_unit: 'kmh'
  }).toString();
}

function normalize(j) {
  const c = j.current;
  const d = j.daily;
  const now = describe(c.weather_code, c.is_day);
  const days = d.time.map(function (date, i) {
    // 'YYYY-MM-DD' parsed as UTC noon, so the weekday is right in any timezone.
    const dow = DAYS[new Date(date + 'T12:00:00Z').getUTCDay()];
    const desc = describe(d.weather_code[i], 1);
    return {
      dow: i === 0 ? 'Today' : dow,
      icon: desc.icon,
      label: desc.label,
      max: round(d.temperature_2m_max[i]),
      min: round(d.temperature_2m_min[i]),
      rain: round(d.precipitation_probability_max[i])
    };
  });
  return {
    place: NAME,
    temp: round(c.temperature_2m),
    feels: round(c.apparent_temperature),
    humidity: round(c.relative_humidity_2m),
    wind: round(c.wind_speed_10m),
    windDir: COMPASS[Math.round(((c.wind_direction_10m || 0) % 360) / 45) % 8],
    label: now.label,
    icon: now.icon,
    days: days,
    updatedAt: Date.now()
  };
}

function create(onChange) {
  const holder = { weather: null, error: null };
  let lastError = '';

  async function refresh() {
    let delay = REFRESH_MS;
    try {
      const res = await fetch(url(), { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      holder.weather = normalize(await res.json());
      holder.error = null;
      lastError = '';
    } catch (err) {
      if (err.message !== lastError) console.warn('weather:', err.message);
      lastError = err.message;
      holder.error = err.message;
      delay = RETRY_MS;
    }
    onChange();
    setTimeout(refresh, delay);
  }

  refresh();
  return holder;
}

module.exports = { create };
