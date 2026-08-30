import { defineRoute } from "@teyik0/furin";
import "./globals.css";

export const route = defineRoute().layout(({ children }) => (
  <div className="min-h-screen">{children}</div>
));
