"use client";

import { useEffect, useState } from "react";
import { getUniqueHeadingId } from "@/lib/docs-heading";
import { cn } from "@/lib/utils";

interface HeadingItem {
  id: string;
  level: 2 | 3;
  text: string;
}

export function DocsToc() {
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    let observer: IntersectionObserver | null = null;
    let cancelled = false;

    function scrollToHashTarget(): void {
      const raw = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
      let hash: string;
      try {
        hash = decodeURIComponent(raw);
      } catch {
        hash = raw;
      }
      if (hash.length === 0) {
        return;
      }

      const target = document.getElementById(hash);
      if (!target) {
        return;
      }

      target.scrollIntoView({ behavior: "smooth", block: "start" });
      setActiveId(hash);
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: DOM traversal, IntersectionObserver setup, retry logic, and hash-scroll handling are inherently coupled; splitting further would obscure the intent
    function registerHeadings() {
      const article = document.getElementById("doc-content");
      if (!article) {
        return false;
      }

      const seen = new Map<string, number>();
      const elements = Array.from(article.querySelectorAll<HTMLHeadingElement>("h2, h3"));
      const nextHeadings: HeadingItem[] = [];
      // Only headings that get an id end up here — empty headings are skipped
      // entirely. The observer must watch THIS list, not `elements`: an
      // observed-but-id-less heading becoming the first visible entry would
      // make the callback's `target.id` guard fall through and freeze the
      // active TOC item.
      const observedHeadings: HTMLHeadingElement[] = [];
      for (const element of elements) {
        const text = element.textContent ?? "";
        if (text.length === 0) {
          continue;
        }
        const id = getUniqueHeadingId(text, seen);
        element.id = id;
        observedHeadings.push(element);
        nextHeadings.push({
          id,
          level: element.tagName === "H2" ? 2 : 3,
          text,
        } satisfies HeadingItem);
      }

      setHeadings(nextHeadings);
      setActiveId(nextHeadings[0]?.id ?? "");
      window.requestAnimationFrame(() => {
        scrollToHashTarget();
      });

      if (nextHeadings.length === 0) {
        return true;
      }

      observer = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((entry) => entry.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);

          if (visible[0]?.target.id) {
            setActiveId(visible[0].target.id);
          }
        },
        {
          rootMargin: "-96px 0px -65% 0px",
          threshold: [0, 1],
        }
      );

      for (const element of observedHeadings) {
        observer.observe(element);
      }

      return true;
    }

    window.addEventListener("hashchange", scrollToHashTarget);

    if (!registerHeadings()) {
      // Retry up to 5 animation frames — handles slow MDX renders without
      // blocking layout or triggering excessive work.
      let attempts = 0;
      const MAX_ATTEMPTS = 5;
      let frameId: number;

      const retry = () => {
        if (cancelled || attempts >= MAX_ATTEMPTS) {
          return;
        }
        attempts++;
        if (!registerHeadings()) {
          frameId = window.requestAnimationFrame(retry);
        }
      };

      frameId = window.requestAnimationFrame(retry);

      return () => {
        cancelled = true;
        window.cancelAnimationFrame(frameId);
        window.removeEventListener("hashchange", scrollToHashTarget);
        observer?.disconnect();
      };
    }

    return () => {
      cancelled = true;
      window.removeEventListener("hashchange", scrollToHashTarget);
      observer?.disconnect();
    };
  }, []);

  if (headings.length === 0) {
    return null;
  }

  return (
    <aside className="hidden xl:block">
      <div className="sticky top-24">
        <p className="mb-4 font-semibold text-foreground text-sm">On this page</p>
        <nav>
          <ul className="space-y-1 border-border border-l pl-4">
            {headings.map((heading) => (
              <li key={heading.id}>
                <button
                  className={cn(
                    "block w-full py-1 text-left text-sm transition-colors",
                    heading.level === 3 && "pl-4 text-xs",
                    activeId === heading.id
                      ? "font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  onClick={() => {
                    const target = document.getElementById(heading.id);
                    if (!target) {
                      return;
                    }

                    target.scrollIntoView({ behavior: "smooth", block: "start" });
                    window.history.replaceState(null, "", `#${heading.id}`);
                    setActiveId(heading.id);
                  }}
                  type="button"
                >
                  {heading.text}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </aside>
  );
}
