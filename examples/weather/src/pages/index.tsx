// oxlint-disable react/rules-of-hooks -- hooks inside furin's route.page() component prop are valid React components
import { Link, useRouter } from "@teyik0/furin/link";
import { useRef } from "react";
import type { DailyForecast, WeatherResponse } from "../api/weather";
import { getWeatherCondition } from "../lib/weather-codes";
import { route } from "./root";

const POPULAR_CITIES = ["Paris", "Tokyo", "New York", "London", "Sydney", "Dubai"];

export default route.page({
  loader: async ({ query, request }) => {
    const city = query.city;
    const url = new URL(`/api/weather?city=${encodeURIComponent(city)}`, request.url);
    const res = await fetch(url);
    const data = (await res.json()) as WeatherResponse | null;

    if (!data) {
      return { weather: null, city, error: `City not found: "${city}"` };
    }

    const dailyWithDayName = data.daily.map((day) => ({
      ...day,
      dayName: new Date(day.date).toLocaleDateString("en", { weekday: "short" }),
    }));

    return { weather: { ...data, daily: dailyWithDayName }, city, error: null };
  },
  head: ({ query }) => ({
    meta: [{ title: `Weather in ${query.city ?? "Paris"}` }],
  }),
  component: ({ weather, city, error }) => {
    const { navigate } = useRouter();
    const formRef = useRef<HTMLFormElement>(null);

    const handleSearch = () => {
      const input = formRef.current?.elements.namedItem("city") as HTMLInputElement | null;
      const value = input?.value.trim();
      if (value) {
        navigate(`/?city=${encodeURIComponent(value)}`);
      }
    };

    return (
      <div className="space-y-8">
        {/* Header */}
        <div>
          <h1 className="font-semibold text-3xl text-white tracking-tight">Weather</h1>
          <p className="mt-1 text-zinc-400">
            Powered by Open-Meteo &mdash; served from a single Bun process
          </p>
        </div>

        {/* Search */}
        <form
          className="flex gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            handleSearch();
          }}
          ref={formRef}
        >
          <input
            className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-white outline-none placeholder:text-zinc-500 focus:border-cyan-400/50 focus:ring-1 focus:ring-cyan-400/30"
            defaultValue={city}
            key={city}
            name="city"
            placeholder="Search city..."
            type="text"
          />
          <button
            className="rounded-xl bg-cyan-500 px-5 py-2.5 font-medium text-sm text-white transition-colors hover:bg-cyan-400"
            type="submit"
          >
            Search
          </button>
        </form>

        {/* Popular cities */}
        <div className="flex flex-wrap gap-2">
          {POPULAR_CITIES.map((c) => (
            <Link
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                city === c
                  ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200"
                  : "border-white/10 bg-white/5 text-zinc-300 hover:border-white/20 hover:text-white"
              }`}
              key={c}
              search={{ city: c }}
              to="/"
            >
              {c}
            </Link>
          ))}
        </div>

        {/* Error state */}
        {error && (
          <div className="rounded-2xl border border-red-400/20 bg-red-400/10 p-6 text-center">
            <p className="text-lg text-red-200">{error}</p>
            <p className="mt-2 text-red-300/70 text-sm">Try a different city name</p>
          </div>
        )}

        {/* Current weather */}
        {weather && <CurrentWeatherCard weather={weather} />}

        {/* 7-day forecast */}
        {weather && <ForecastGrid daily={weather.daily} />}
      </div>
    );
  },
});

function CurrentWeatherCard({ weather }: { weather: WeatherResponse }) {
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

type DailyForecastWithDayName = DailyForecast & { dayName: string };

function ForecastGrid({ daily }: { daily: DailyForecastWithDayName[] }) {
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
