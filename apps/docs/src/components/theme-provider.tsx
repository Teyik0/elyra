import { createContext, use, useEffect, useReducer } from "react";

export type Theme = "dark" | "light";

const ThemeContext = createContext<{
  theme: Theme;
  toggleTheme: () => void;
}>({
  theme: "dark",
  toggleTheme: () => {
    /* noop */
  },
});

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem("furin-theme") as Theme | null;
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // localStorage unavailable (private mode, sandboxed iframe, etc.) — keep default
  }
  return "dark";
}

function themeReducer(_state: Theme, action: "toggle" | Theme): Theme {
  if (action === "toggle") {
    return _state === "dark" ? "light" : "dark";
  }
  return action;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, dispatch] = useReducer(themeReducer, "dark");

  // Read persisted theme once on mount — replaces the two-effect chain
  useEffect(() => {
    const stored = readStoredTheme();
    dispatch(stored);
  }, []);

  // shadcn best practice: apply theme class on <html> so Radix portals
  // (dropdowns, dialogs, tooltips…) inherit the correct color scheme.
  // Combined with the mount effect above to break the previous effect chain.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
  }, [theme]);

  const toggleTheme = () => {
    dispatch("toggle");
    const next = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("furin-theme", next);
    } catch {
      // ignore
    }
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      <div className="min-h-screen bg-background text-foreground">{children}</div>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return use(ThemeContext);
}
