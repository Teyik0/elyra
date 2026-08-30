import { t } from "elysia";
import "./globals.css";
import { defineRoute } from "@teyik0/furin";

export const route = defineRoute()
  .config({
    query: t.Object({
      city: t.String({ default: "Paris" }),
    }),
  })
  .layout(({ children }) => (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col px-6 py-12">{children}</main>
  ));
