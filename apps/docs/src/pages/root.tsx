import "./globals.css";
import { defineRootRoute } from "@teyik0/furin";
import { RootLayout } from "@/components/root-layout";

export const route = defineRootRoute()
  .config({ mode: "ssg" })
  .layout(({ children }) => <RootLayout>{children}</RootLayout>);
