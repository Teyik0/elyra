import { defineRootRoute } from "@teyik0/furin";
import "./globals.css";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => <div className="min-h-screen">{children}</div>);
