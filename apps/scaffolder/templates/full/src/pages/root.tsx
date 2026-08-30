import { defineRoute } from "@teyik0/furin";
import "./globals.css";

export const route = defineRoute().layout(({ children }) => (
  <main className="mx-auto flex min-h-screen max-w-5xl items-center px-6 py-16">{children}</main>
));
