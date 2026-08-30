import "./globals.css";
import { defineRoute } from "@teyik0/furin";
import { RootLayout } from "@/components/root-layout";

export const route = defineRoute()
  .config({ mode: "ssg" })
  .layout(({ children }) => <RootLayout>{children}</RootLayout>);
