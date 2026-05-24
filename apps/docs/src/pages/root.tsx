import "./globals.css";
import { createRoute } from "@teyik0/furin/client";
import { RootLayout } from "@/components/root-layout";

export const route = createRoute({
  mode: "ssg",
  layout: ({ children }) => <RootLayout>{children}</RootLayout>,
});
