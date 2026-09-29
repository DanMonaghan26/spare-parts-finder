# Spare Parts Finder

A chat assistant for finding spare parts for major domestic appliances
(washing machines, tumble dryers, dishwashers, fridges and freezers, ovens,
cookers, hobs, cooker hoods and microwaves).

1. **Describe the fault** in your own words — "my washing machine won't drain",
   "the oven fan is grinding". The assistant asks a couple of follow-ups and
   explains the most likely faulty parts (and any free checks to try first).
2. **Pin down the exact model number.** It tells you where the rating plate is
   on your type of appliance, can read a photo of the plate, searches eSpares
   and asks you to pick the right variant when there are several.
3. **Find the part.** It opens your model's page on
   [eSpares](https://www.espares.co.uk) and suggests matching parts with the
   price, part number and a link to buy.

A summary panel beside the chat keeps track of the appliance, the confirmed
model, the likely faults and the suggested parts.

## Tech stack

- [Next.js](https://nextjs.org) (App Router) + TypeScript + Tailwind CSS
- [Claude](https://platform.claude.com) via the official `@anthropic-ai/sdk`
  (model `claude-opus-5-5`), with tools for searching and reading eSpares
- No database or accounts — each conversation lives in the browser tab

## How the eSpares lookup works

eSpares doesn't have a public API, so the server reads its public pages the
way a browser would (`src/lib/espares.ts`):

- `search_espares` runs an eSpares search and pulls out model pages, products
  (name, price, part number, link) and part categories.
- `open_espares_page` opens a model, category or product page. Only
  `www.espares.co.uk` URLs are allowed.
- If eSpares blocks those requests, Claude falls back to Anthropic's hosted
  web search/fetch tools, restricted to `espares.co.uk`.

eSpares' search URL isn't documented, so the app tries a few known shapes and
remembers the one that works. If their site changes, set `ESPARES_SEARCH_URL`
(see `.env.example`).

## Deploy it for free on Vercel

1. **Get an Anthropic API key.** Sign in at
   [platform.claude.com](https://platform.claude.com), add some credit under
   Billing, and create a key under **API keys**. It's worth setting a monthly
   spend limit too, because the deployed chat page is public.
2. **Create a new Vercel project.** At [vercel.com](https://vercel.com) click
   **Add New → Project** and import this GitHub repository. The framework
   preset is detected as Next.js automatically; leave the build settings as
   they are.
3. Before the first deploy, open **Environment Variables** and add:
   - `ANTHROPIC_API_KEY` — the key from step 1
4. Click **Deploy**. You'll get a URL like `https://spare-parts-finder.vercel.app`
   that works on any phone, tablet or laptop, and can be added to the home
   screen.

Every push to the repository redeploys automatically.

> The chat endpoint runs for up to 5 minutes per reply (`maxDuration` in
> `src/app/api/chat/route.ts`), which is within Vercel's free-tier limit when
> Fluid Compute is on (the default for new projects).

## Running it locally

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
npm run dev
```

Open http://localhost:3000.

## Project structure

```
src/app/page.tsx           The page (renders the chat)
src/app/api/chat/route.ts  Streams Claude's replies to the browser
src/lib/agent.ts           System prompt, tools and the tool-use loop
src/lib/espares.ts         eSpares search + page reader
src/lib/case.ts            Schema for the summary panel ("case file")
src/components/Chat.tsx    Chat UI, photo upload, streaming client
src/components/CasePanel.tsx  Summary panel
src/components/Markdown.tsx   Minimal, safe Markdown for replies
```
