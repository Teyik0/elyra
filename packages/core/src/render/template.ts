// ── Dev template ─────────────────────────────────────────────────────────────

let _devTemplatePromise: Promise<string> | null = null;

export function getDevTemplate(origin: string): Promise<string> {
  _devTemplatePromise ??= fetch(`${origin}/_bun_hmr_entry`)
    .then((r) => {
      if (!r.ok) {
        throw new Error(`/_bun_hmr_entry returned ${r.status}`);
      }
      return r.text();
    })
    .catch((err) => {
      _devTemplatePromise = null;
      throw err;
    });
  return _devTemplatePromise;
}
