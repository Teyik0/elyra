import type { WeatherResponse } from "../api/weather";
import { getWeatherCondition } from "../lib/weather-codes";

export function CurrentWeatherCard({ weather }: { weather: WeatherResponse }) {
  const condition = getWeatherCondition(weather.current.weatherCode);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-8">
      <div className="flex items-start justify-between">
        <div>
          <p className="font-medium text-sm text-zinc-400 uppercase tracking-widest">
            Current weather
          </p>
          <p className="mt-1 text-lg text-zinc-300">
            {weather.city}, {weather.country}
          </p>
        </div>
        <span className="text-5xl">{condition.emoji}</span>
      </div>
      <div className="mt-6 flex items-end gap-8">
        <p className="font-bold text-6xl text-white">
          {Math.round(weather.current.temperature)}&deg;C
        </p>
        <div className="mb-1 space-y-1 text-sm text-zinc-400">
          <p>{condition.label}</p>
          <p>Wind: {weather.current.windSpeed} km/h</p>
        </div>
      </div>
    </div>
  );
}
