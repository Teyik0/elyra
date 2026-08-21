interface WeatherCondition {
  emoji: string;
  label: string;
}

const WEATHER_CODES: Record<number, WeatherCondition> = {
  0: { emoji: "\u2600\uFE0F", label: "Clear sky" },
  1: { emoji: "\uD83C\uDF24\uFE0F", label: "Mainly clear" },
  2: { emoji: "\u26C5", label: "Partly cloudy" },
  3: { emoji: "\u2601\uFE0F", label: "Overcast" },
  45: { emoji: "\uD83C\uDF2B\uFE0F", label: "Fog" },
  48: { emoji: "\uD83C\uDF2B\uFE0F", label: "Rime fog" },
  51: { emoji: "\uD83C\uDF26\uFE0F", label: "Light drizzle" },
  53: { emoji: "\uD83C\uDF26\uFE0F", label: "Moderate drizzle" },
  55: { emoji: "\uD83C\uDF27\uFE0F", label: "Dense drizzle" },
  61: { emoji: "\uD83C\uDF27\uFE0F", label: "Slight rain" },
  63: { emoji: "\uD83C\uDF27\uFE0F", label: "Moderate rain" },
  65: { emoji: "\uD83C\uDF27\uFE0F", label: "Heavy rain" },
  71: { emoji: "\uD83C\uDF28\uFE0F", label: "Slight snow" },
  73: { emoji: "\u2744\uFE0F", label: "Moderate snow" },
  75: { emoji: "\u2744\uFE0F", label: "Heavy snow" },
  77: { emoji: "\uD83C\uDF28\uFE0F", label: "Snow grains" },
  80: { emoji: "\uD83C\uDF26\uFE0F", label: "Light showers" },
  81: { emoji: "\uD83C\uDF27\uFE0F", label: "Moderate showers" },
  82: { emoji: "\u26C8\uFE0F", label: "Violent showers" },
  85: { emoji: "\uD83C\uDF28\uFE0F", label: "Light snow showers" },
  86: { emoji: "\u2744\uFE0F", label: "Heavy snow showers" },
  95: { emoji: "\u26C8\uFE0F", label: "Thunderstorm" },
  96: { emoji: "\u26C8\uFE0F", label: "Thunderstorm with hail" },
  99: { emoji: "\u26C8\uFE0F", label: "Thunderstorm with heavy hail" },
};

export function getWeatherCondition(code: number): WeatherCondition {
  return WEATHER_CODES[code] ?? { emoji: "\u2753", label: "Unknown" };
}
