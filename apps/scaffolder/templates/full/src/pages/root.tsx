import { defineRootRoute } from "@teyik0/furin";
import "./globals.css";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <main className="mx-auto flex min-h-screen max-w-5xl items-center px-6 py-16">{children}</main>
  ));
