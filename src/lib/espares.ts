import "server-only";
import { parse, type HTMLElement } from "node-html-parser";

const ORIGIN = "https://www.espares.co.uk";

// eSpares doesn't publish a search API, so we read its public HTML pages the
// same way a browser would. The search URL isn't documented anywhere, so we try
// a few known shapes (plus an optional override) and remember whichever one
// returns results.
const SEARCH_TEMPLATES = [
  process.env.ESPARES_SEARCH_URL,
  `${ORIGIN}/search.pl?q={q}`,
  `${ORIGIN}/search/?q={q}`,
  `${ORIGIN}/search?q={q}`,
].filter((t): t is string => Boolean(t));

let workingTemplate: string | null = null;

const FETCH_TIMEOUT_MS = 12_000;
const MAX_ITEMS = 15;
const EXCERPT_CHARS = 2500;
// Repair guides are long articles; give Claude enough of one to follow it.
const GUIDE_EXCERPT_CHARS = 9000;

export type EsparesModel = { title: string; url: string };
export type EsparesProduct = {
  name: string;
  url: string;
  price?: string;
  partNumber?: string;
};
export type EsparesCategory = { name: string; url: string };
export type EsparesGuide = { title: string; url: string };

export type EsparesPage = {
  url: string;
  title: string;
  heading?: string;
  price?: string;
  models: EsparesModel[];
  products: EsparesProduct[];
  categories: EsparesCategory[];
  guides: EsparesGuide[];
  excerpt: string;
};

export class EsparesError extends Error {}

/** Only ever fetch eSpares itself — the URL can come from model output. */
export function toEsparesUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw, ORIGIN);
  } catch {
    throw new EsparesError(`Not a valid URL: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || (host !== "espares.co.uk" && host !== "www.espares.co.uk")) {
    throw new EsparesError("Only https://www.espares.co.uk pages can be opened.");
  }
  url.protocol = "https:";
  url.hostname = "www.espares.co.uk";
  url.port = "";
  return url;
}

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        // A normal browser UA; eSpares serves bot-looking clients a block page.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-GB,en;q=0.9",
      },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new EsparesError(`Couldn't reach eSpares (${(err as Error).message}).`);
  }
  if (!res.ok) {
    throw new EsparesError(`eSpares returned HTTP ${res.status} for ${url}.`);
  }
  return { html: await res.text(), finalUrl: res.url || url };
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function findPrice(el: HTMLElement): string | undefined {
  // Walk up a few levels from the link to the product "card" and look for £x.xx.
  let node: HTMLElement | null = el;
  for (let i = 0; i < 5 && node; i++) {
    const match = node.text.match(/£\s?\d{1,4}(?:,\d{3})*\.\d{2}/);
    if (match) return match[0].replace(/\s/g, "");
    node = node.parentNode as HTMLElement | null;
  }
  return undefined;
}

function partNumberFrom(name: string): string | undefined {
  return name.match(/Part Number:?\s*([A-Z0-9][A-Z0-9./-]+)/i)?.[1]?.replace(/\.$/, "");
}

function parsePage(html: string, pageUrl: string): EsparesPage {
  const root = parse(html);
  root.querySelectorAll("script:not([type='application/ld+json']), style, noscript, svg").forEach((n) => n.remove());

  const models = new Map<string, EsparesModel>();
  const products = new Map<string, EsparesProduct>();
  const categories = new Map<string, EsparesCategory>();
  const guides = new Map<string, EsparesGuide>();

  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (!href) continue;
    let url: URL;
    try {
      url = toEsparesUrl(href);
    } catch {
      continue;
    }
    const text = clean(a.getAttribute("title") || a.text);
    if (!text) continue;
    const key = url.pathname + url.search;

    if (url.pathname.endsWith("/product.pl") && url.searchParams.get("pid")) {
      const existing = products.get(key);
      // The same product is often linked twice (image + title); keep the longer label.
      if (!existing || existing.name.length < text.length) {
        products.set(key, {
          name: text,
          url: url.toString(),
          price: findPrice(a) ?? existing?.price,
          partNumber: partNumberFrom(text),
        });
      }
    } else if (url.pathname.endsWith("/catalogue.pl") && url.searchParams.get("model_ref")) {
      if (!url.searchParams.get("refine")) {
        if (!models.has(key)) models.set(key, { title: text, url: url.toString() });
      } else if (!categories.has(key)) {
        categories.set(key, { name: text, url: url.toString() });
      }
    } else if (url.pathname.endsWith("/catalogue.pl") && url.searchParams.get("refine")) {
      if (!categories.has(key)) categories.set(key, { name: text, url: url.toString() });
    } else if (isGuidePath(url.pathname)) {
      const existing = guides.get(key);
      if (!existing || existing.title.length < text.length) guides.set(key, { title: text, url: url.toString() });
    }
  }

  // Structured data, when present, is more reliable than link scraping.
  for (const script of root.querySelectorAll("script[type='application/ld+json']")) {
    try {
      const data = JSON.parse(script.text);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item?.["@type"] === "Product" && item.name) {
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          const url = item.url ? toEsparesUrl(item.url).toString() : pageUrl;
          const key = new URL(url).pathname + new URL(url).search;
          products.set(key, {
            name: clean(item.name),
            url,
            price: offer?.price ? `£${Number(offer.price).toFixed(2)}` : products.get(key)?.price,
            partNumber: item.mpn || item.sku || partNumberFrom(item.name),
          });
        }
      }
    } catch {
      // Ignore malformed JSON-LD.
    }
    script.remove();
  }

  const main = root.querySelector("main") ?? root.querySelector("body") ?? root;
  const heading = clean(root.querySelector("h1")?.text) || undefined;

  return {
    url: pageUrl,
    title: clean(root.querySelector("title")?.text),
    heading,
    price: pageUrl.includes("/product.pl") ? findPrice(root.querySelector("h1") ?? main) : undefined,
    models: [...models.values()].slice(0, MAX_ITEMS),
    products: [...products.values()].slice(0, MAX_ITEMS * 2),
    categories: [...categories.values()].slice(0, 40),
    guides: [...guides.values()].slice(0, 150),
    excerpt: clean(main.text).slice(0, isGuidePath(new URL(pageUrl).pathname) ? GUIDE_EXCERPT_CHARS : EXCERPT_CHARS),
  };
}

/**
 * eSpares repair guides live at e.g.
 *   /washing-machines/symptom/washing-machine-not-draining-water/advice.pl
 *   /advice/careandmaintenance/how-to-diagnose-washing-machine-drain-and-pump-problems
 */
function isGuidePath(path: string) {
  return /^\/[^/]+\/(symptom|careandmaintenance)\/[^/]+\/advice\.pl$/.test(path) ||
    /^\/advice\/(symptom|careandmaintenance)\/[^/]+$/.test(path);
}

function looksBlocked(page: EsparesPage) {
  return /access denied|just a moment|attention required|captcha/i.test(page.title + " " + page.excerpt.slice(0, 300));
}

/** Search eSpares for a model number or a "brand + model + part" query. */
export async function searchEspares(query: string): Promise<EsparesPage> {
  const q = encodeURIComponent(query.trim());
  const templates = workingTemplate
    ? [workingTemplate, ...SEARCH_TEMPLATES.filter((t) => t !== workingTemplate)]
    : SEARCH_TEMPLATES;

  let lastError: Error | null = null;
  for (const template of templates) {
    try {
      const { html, finalUrl } = await fetchHtml(template.replace("{q}", q));
      const page = parsePage(html, finalUrl);
      if (looksBlocked(page)) throw new EsparesError("eSpares served a bot-check page.");
      if (page.models.length || page.products.length || finalUrl.includes("model_ref=")) {
        workingTemplate = template;
        return page;
      }
      lastError = new EsparesError(`No results for "${query}".`);
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new EsparesError("Search failed.");
}

/** Open a model, category or product page on eSpares. */
export async function getEsparesPage(rawUrl: string): Promise<EsparesPage> {
  const url = toEsparesUrl(rawUrl);
  const { html, finalUrl } = await fetchHtml(url.toString());
  const page = parsePage(html, finalUrl);
  if (looksBlocked(page)) throw new EsparesError("eSpares served a bot-check page.");
  return page;
}

/** A link a person can click to run the same search themselves. */
export function esparesSearchLink(query: string) {
  return (workingTemplate ?? SEARCH_TEMPLATES[0]).replace("{q}", encodeURIComponent(query.trim()));
}

// eSpares' repair help centre has a hub per appliance type. Some slugs are
// confirmed (washing-machines, dishwashers, fridges-and-freezers); the others
// are best guesses, so each appliance tries a couple of shapes.
export const GUIDE_APPLIANCES = {
  "washing machine": ["washing-machines"],
  "washer dryer": ["washer-dryers", "washing-machines"],
  "tumble dryer": ["tumble-dryers"],
  dishwasher: ["dishwashers"],
  "fridge or freezer": ["fridges-and-freezers"],
  "oven or cooker": ["cookers-and-ovens", "ovens", "cookers"],
  hob: ["hobs", "cookers-and-ovens"],
  "cooker hood": ["cooker-hoods"],
  microwave: ["microwaves"],
} as const;

export type GuideAppliance = keyof typeof GUIDE_APPLIANCES;

const STOP_WORDS = new Set(
  "a an and are at be but by does doesnt dont for from has have how i in is isnt it its my not of on or the to too very was when where which why wont with work working".split(" "),
);

function keywords(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Loosely match word forms, e.g. "drain" ~ "draining", "leak" ~ "leaking". */
function related(a: string, b: string) {
  const n = Math.min(a.length, b.length, 5);
  return n >= 4 && a.slice(0, n) === b.slice(0, n);
}

/** Find eSpares repair guides for an appliance, ranked by relevance to the problem. */
export async function findRepairGuides(appliance: GuideAppliance, problem: string) {
  const urls = GUIDE_APPLIANCES[appliance].flatMap((slug) => [
    `${ORIGIN}/${slug}/advice.pl`,
    `${ORIGIN}/advice/appliancetype/${slug}`,
  ]);
  const pages = await Promise.allSettled(urls.map((u) => getEsparesPage(u)));

  const guides = new Map<string, EsparesGuide>();
  for (const page of pages) {
    if (page.status !== "fulfilled") continue;
    for (const g of page.value.guides) guides.set(g.url, g);
  }
  if (guides.size === 0) {
    const failure = pages.find((p): p is PromiseRejectedResult => p.status === "rejected");
    throw failure?.reason instanceof EsparesError
      ? failure.reason
      : new EsparesError(`Couldn't find eSpares' ${appliance} repair guides.`);
  }

  const wanted = keywords(problem);
  const ranked = [...guides.values()]
    .map((g) => {
      const words = keywords(`${g.title} ${new URL(g.url).pathname.replace(/[-/]/g, " ")}`);
      const score =
        wanted.filter((w) => words.some((x) => related(w, x))).length +
        (g.url.includes("/symptom/") ? 0.5 : 0);
      return { ...g, score };
    })
    .sort((a, b) => b.score - a.score);

  return {
    appliance,
    guides: ranked.slice(0, 10).map(({ title, url }) => ({ title, url })),
    totalGuidesSeen: guides.size,
  };
}
