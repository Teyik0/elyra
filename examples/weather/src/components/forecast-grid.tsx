import type { DailyForecast } from "../api/weather";
import { getWeatherCondition } from "../lib/weather-codes";

type DailyForecastWithDayName = DailyForecast & { dayName: string };

export function ForecastGrid({ daily }: { daily: DailyForecastWithDayName[] }) {
  return (
    <div>
      <h2 className="mb-4 font-semibold text-lg text-white">7-Day Forecast</h2>
      <div className="grid gap-3 sm:grid-cols-7">
        {daily.map((day) => {
          const condition = getWeatherCondition(day.weatherCode);
          return (
            <div
              className="flex flex-col items-center rounded-xl border border-white/10 bg-white/5 p-3"
              key={day.date}
            >
              <p className="font-medium text-xs text-zinc-400">{day.dayName}</p>
              <span className="my-2 text-2xl">{condition.emoji}</span>
              <p className="font-semibold text-sm text-white">
                {Math.round(day.temperatureMax)}&deg;
              </p>
              <p className="text-xs text-zinc-500">{Math.round(day.temperatureMin)}&deg;</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
