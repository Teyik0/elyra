/**
 * HMR Test Script for Elysion Framework
 *
 * Tests that Hot Module Replacement updates the page visually
 * without a full page reload, and without hydration errors.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

const INDEX_PATH = resolve(import.meta.dir, "../src/pages/blog/route.tsx");

// "All Posts" is a JSX text node in the blog sidebar — unique and not part of any identifier
const ORIGINAL_TEXT = "All Posts";
const MODIFICATIONS = ["All Posts 2", "All Posts 3", "All Posts 4", "All Posts 5"];

interface Modification {
  consoleLogs: string[];
  contentChanged: boolean | null;
  finalText: string | null;
  from: string;
  hmrLogFound: boolean | null;
  hydrationErrors: string[];
  label: string;
  noFullReload: boolean | null;
  to: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFile(path: string): string {
  return readFileSync(path, "utf-8");
}

function writeFile(path: string, content: string): void {
  writeFileSync(path, content, "utf-8");
}

async function getTargetText(page: Page): Promise<string | null> {
  // Target the "All Posts" link in the blog sidebar (blog/route.tsx layout)
  return await page
    .$eval('aside a[href="/blog"]', (el) => el.textContent?.trim() ?? null)
    .catch(() => null);
}

async function runSingleModification(
  page: Page,
  i: number,
  newText: string,
  previousText: string,
  allConsoleLogs: string[],
  reloadRef: { value: boolean }
): Promise<Modification> {
  const label = `Modification ${i + 1}`;
  console.log(`\n${"─".repeat(60)}`);
  console.log(`[${i + 2}] ${label}: "${previousText}" → "${newText}"`);

  const modResult: Modification = {
    label,
    from: previousText,
    to: newText,
    contentChanged: null,
    noFullReload: null,
    hmrLogFound: null,
    hydrationErrors: [],
    consoleLogs: [],
    finalText: null,
  };

  // Reset reload tracker
  reloadRef.value = false;
  const logsBeforeModification = allConsoleLogs.length;

  // Modify the file
  const content = readFile(INDEX_PATH);
  const updatedContent = content.replace(
    new RegExp(previousText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    newText
  );

  if (content === updatedContent) {
    console.log(`    ERROR: Could not find "${previousText}" in file!`);
    modResult.contentChanged = false;
    return modResult;
  }

  writeFile(INDEX_PATH, updatedContent);
  console.log("    File written. Waiting 2.5s for HMR update...");

  // Wait for HMR
  await sleep(2500);

  // Collect new logs since modification
  const newLogs = allConsoleLogs.slice(logsBeforeModification);
  modResult.consoleLogs = newLogs;

  // Check for hydration errors in new logs
  modResult.hydrationErrors = newLogs.filter(
    (log) =>
      log.includes("Hydration failed") ||
      log.includes("throwOnHydrationMismatch") ||
      log.toLowerCase().includes("hydration")
  );

  // Check HMR log presence
  modResult.hmrLogFound = newLogs.some(
    (log) =>
      log.includes("[hmr]") ||
      log.includes("Manual re-render") ||
      log.includes("re-render complete") ||
      log.includes("hot-update") ||
      log.includes("Fast Refresh")
  );

  // Check content updated
  const currentText = await getTargetText(page);
  modResult.finalText = currentText;
  modResult.contentChanged = currentText === newText;
  modResult.noFullReload = !reloadRef.value;

  // Print result
  console.log(`    sidebar "All Posts" link now: "${currentText}"`);
  console.log(`    Content changed: ${modResult.contentChanged ? "✓ YES" : "✗ NO"}`);
  console.log(
    `    No full reload:  ${modResult.noFullReload ? "✓ YES" : "✗ NO (RELOAD DETECTED)"}`
  );
  console.log(`    HMR log found:   ${modResult.hmrLogFound ? "✓ YES" : "✗ NOT FOUND"}`);

  if (modResult.hydrationErrors.length > 0) {
    console.log(`    Hydration errors: ✗ FOUND ${modResult.hydrationErrors.length}`);
    for (const err of modResult.hydrationErrors) {
      console.log(`      → ${err}`);
    }
  } else {
    console.log("    Hydration errors: ✓ NONE");
  }

  if (newLogs.length > 0) {
    console.log("    Console logs during this modification:");
    for (const log of newLogs.slice(0, 10)) {
      console.log(`      ${log}`);
    }
    if (newLogs.length > 10) {
      console.log(`      ... and ${newLogs.length - 10} more`);
    }
  } else {
    console.log("    Console logs: (none captured)");
  }

  return modResult;
}

function printFinalReport(results: Modification[]): boolean {
  console.log(`\n${"=".repeat(60)}`);
  console.log("  FINAL REPORT");
  console.log("=".repeat(60));

  let allPassed = true;

  for (const result of results) {
    const pass =
      result.contentChanged === true &&
      result.noFullReload === true &&
      result.hydrationErrors.length === 0;

    if (!pass) {
      allPassed = false;
    }

    const status = pass ? "PASS" : "FAIL";
    console.log(`\n  [${status}] ${result.label}`);
    console.log(
      `    Content changed:   ${result.contentChanged ? "YES" : "NO"} (expected: "${result.to}", got: "${result.finalText}")`
    );
    console.log(`    No full reload:    ${result.noFullReload ? "YES" : "NO"}`);
    console.log(`    HMR log found:     ${result.hmrLogFound ? "YES" : "NO"}`);
    console.log(
      `    Hydration errors:  ${result.hydrationErrors.length === 0 ? "NONE" : `${result.hydrationErrors.length} ERROR(S)`}`
    );
  }

  console.log(`\n${"─".repeat(60)}`);
  if (allPassed) {
    console.log("  OVERALL: ALL TESTS PASSED ✓");
  } else {
    const failCount = results.filter(
      (r) => r.contentChanged !== true || r.noFullReload !== true || r.hydrationErrors.length > 0
    ).length;
    console.log(`  OVERALL: ${failCount}/${results.length} TEST(S) FAILED ✗`);
  }
  console.log("=".repeat(60));

  return allPassed;
}

async function runHmrTest() {
  console.log("=".repeat(60));
  console.log("  HMR Test Suite — Elysion Framework");
  console.log("=".repeat(60));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const allConsoleLogs: string[] = [];
  const hydrationErrors: string[] = [];
  const reloadRef = { value: false };

  // Track console logs
  page.on("console", (msg) => {
    const text = msg.text();
    allConsoleLogs.push(`[${msg.type()}] ${text}`);
    if (
      text.includes("Hydration failed") ||
      text.includes("throwOnHydrationMismatch") ||
      text.includes("hydration") ||
      text.includes("Hydration")
    ) {
      hydrationErrors.push(text);
    }
  });

  // Track navigation (full reload = new navigation)
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && allConsoleLogs.length > 0) {
      reloadRef.value = true;
      allConsoleLogs.push("[SYSTEM] Full page reload detected!");
    }
  });

  // ── Step 1: Navigate to the page ───────────────────────────────
  console.log("\n[1] Navigating to http://localhost:3000/blog ...");
  await page.goto("http://localhost:3000/blog", { waitUntil: "networkidle" });

  const initialText = await getTargetText(page);
  console.log(`    Initial sidebar "All Posts" link: "${initialText}"`);

  if (initialText !== ORIGINAL_TEXT) {
    console.log(`    WARNING: Expected "${ORIGINAL_TEXT}", got "${initialText}"`);
  }

  // Give HMR WebSocket time to connect
  await sleep(1000);
  console.log("    HMR WebSocket should be connected now.");

  // ── Run 4 modifications ─────────────────────────────────────────
  const results: Modification[] = [];
  let previousText = initialText ?? ORIGINAL_TEXT;

  for (let i = 0; i < MODIFICATIONS.length; i++) {
    const newText = MODIFICATIONS[i] ?? ORIGINAL_TEXT;
    const modResult = await runSingleModification(
      page,
      i,
      newText,
      previousText,
      allConsoleLogs,
      reloadRef
    );
    results.push(modResult);
    previousText = newText;
  }

  // ── Final Report ───────────────────────────────────────────────
  const allPassed = printFinalReport(results);

  // ── Restore original file ─────────────────────────────────────
  console.log("\n[Cleanup] Restoring original file...");
  const content = readFile(INDEX_PATH);
  const lastModification = MODIFICATIONS.at(-1) ?? ORIGINAL_TEXT;
  const restored = content.replace(
    new RegExp(lastModification.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
    ORIGINAL_TEXT
  );
  writeFile(INDEX_PATH, restored);
  console.log("[Cleanup] Original file restored.");

  await browser.close();
  process.exit(allPassed ? 0 : 1);
}

runHmrTest().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
