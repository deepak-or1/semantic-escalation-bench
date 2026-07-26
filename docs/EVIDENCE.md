# Evidence

The citation appendix for the benchmark. The lab's chaos is invented, but the failure modes its three drift mechanisms model are not: each section below maps one of the lab's drift modes (`classDrift`, `layoutVariant`, `columnShuffle`) — or one design decision — to primary-source and practitioner evidence. The remaining chaos flags model familiar mechanical obstacles (consent walls, modals, delayed renders, pagination, session expiry, corrupt cells) that are not individually cited, and the Phase-2A decoy and small-page axes are constructed diagnostic probes, not observed incidents.

**Verification method.** Every quote below was re-fetched from its live source and machine-verified **verbatim** on 2026-07-20 (27 by the automated re-verification sweep; the 28th — baseballr issue #408, whose bracketed title defeated the extraction regex — verified by hand; two Stagehand docs quotes additionally confirmed by raw-HTML re-checks; ledger: `evidence/phase1/citations/evidence-reverification-summary.json`). One further candidate — an Optimizely Web Experimentation docs page (`https://docs.developers.optimizely.com/web-experimentation/docs/dynamic-websites`) — carried a verbatim quote but did **not** support the broader claim built on it (the page describes a `MutationObserver` as an activation *trigger*, not an autonomous DOM-rewrite engine), so it was dropped rather than stretched. What remains is 28 confirmed citations. Quotes are reproduced exactly as found, including their original formatting and any typos.

| Section | Lab chaos mode / decision |
| --- | --- |
| [Class drift](#class-drift--the-classdrift-chaos-mode) | `classDrift` |
| [Layout variants](#layout-variants--the-layoutvariant-chaos-mode) | `layoutVariant` |
| [Column drift](#column-drift--the-columnshuffle-chaos-mode) | `columnShuffle` |
| [Maintenance burden](#maintenance-burden--why-this-benchmark-exists) | why the benchmark exists |
| [Sports sites churn](#sports-sites-churn--why-this-domain) | why this domain |
| [Stagehand features](#stagehand-features--the-official-patterns-the-engines-exercise) | which Stagehand / Browserbase patterns the engines exercise |

---

## Class drift → the `classDrift` chaos mode

When `classDrift` is on, every CSS class carries a seed-derived suffix and ids/`data-testid`s are stripped. That is not a contrived attack — it is the ordinary output of modern build tooling and the reason class-name selectors rot on rebuild.

**Claim.** styled-components' own FAQ documents that the dynamic class it attaches to every element differs per-props/interpolation (i.e., it is not a fixed identifier you can hardcode a selector against).

> The other is dynamic, meaning it will be different for every element of your styled component with different props, based on what the interpolations result in. It will probably look like .fVOeaW (note the lack of "sc" prefix.)

**Source:** [FAQs | styled-components](https://styled-components.com/docs/faqs)

**Claim.** css-loader, webpack's official CSS Modules implementation, states plainly that it replaces a developer's local class names with generated unique identifiers, and its documented default naming pattern is a base64 hash rather than the source name.

> The loader replaces local selectors with unique, scoped identifiers. The chosen unique identifiers are exported by the module.

**Source:** [GitHub - webpack/css-loader: CSS Loader](https://github.com/webpack/css-loader)

**Claim.** A scraping practitioner explicitly warns that class-name hashing/mangling (as produced by CSS-in-JS/CSS Modules-style build tooling) breaks selector-based scrapers whenever the target site is rebuilt.

> But if the site gets rebuilt then the class names will all get new randomised suffixes and your carefully crafted crawler will cease to work.

**Source:** [Web Scraping with Class Name Mangling](https://datawookie.dev/blog/2024/01/scraping-with-class-name-mangling/)

**Claim.** Practitioner guidance for building reliable scraping/automation selectors singles out dynamically/build-generated class names as a category to avoid, since they change whenever the site is rebuilt, and cites Google's own homepage search button (built with Google's Closure Framework) as a real production example of such generated class names.

> Dynamic class names are computed when the code is compiled/bundled. That's because the class names in the HTML file must match the names in separate CSS stylesheets. Dynamic class names will change whenever the site is updated.

**Source:** [7 bite-sized tips for reliable web automation and scraping selectors](https://blog.pixiebrix.com/blog/7-bite-sized-tips-for-reliable-web-automation-and-scraping-selectors)

**Claim.** A web-scraping vendor's CSS-selector reference guide advises scrapers to prefer semantic class names over auto-generated ones, using an example class name pattern (.css-1a2b3c) matching the literal 'css-' hash prefix that Emotion/CSS-in-JS tooling generates.

> Prefer semantic class names: .product-title is more stable than .css-1a2b3c (auto-generated)

**Source:** [Ultimate CSS Selector Cheatsheet for Web Scraping and HTML Parsing](https://scrapfly.io/blog/posts/css-selector-cheatsheet)

---

## Layout variants → the `layoutVariant` chaos mode

`layoutVariant` swaps the standings table for a card grid and the odds board for a stacked list. Real sites do this two ways: A/B experiment engines that mutate the DOM per variant, and responsive CSS that renders the same data in a different structure per viewport.

**Claim.** VWO's experimentation engine tracks every DOM insertion, deletion, and modification made by an active test and continuously re-applies the experiment's changes to the page, so different users (or the same user across reloads) can see structurally different DOM depending on their assigned variant.

> While applying these changes to your webpage, VWO detects all changes made on the page (insertion, deletion, and modification of DOM nodes) by the test and re-applies them to ensure regularity in user experience.

**Source:** [Creating a friction-free Experience when experimenting on SPA | VWO](https://vwo.com/blog/how-vwo-makes-experimentation-on-spa-friction-free/)

**Claim.** A widely-cited CSS technique (from CSS-Tricks) converts an HTML table into a stacked card/list layout on small screens by forcing every table element to block-level display and regenerating headers as CSS-injected labels, meaning the same underlying data is delivered inside a completely different DOM/CSS presentation depending on viewport.

> The biggest change is that we are going to force the table to not behave like a table by setting every table-related element to be block-level.

**Source:** [Responsive Data Tables | CSS-Tricks](https://css-tricks.com/responsive-data-tables/)

**Claim.** A scraping-tooling practitioner writeup argues that because A/B/UX experiments are often delivered via client-side JavaScript that mutates the page after load, plain HTML-fetching scrapers cannot reliably see the resulting variant markup, and recommends detecting variants by diffing the DOM of the same page across repeated visits.

> Because these experiments often involve subtle JavaScript‑driven behaviors, traditional HTML‑only scraping is insufficient. Tools must execute scripts, mimic real user behavior, and reliably handle anti‑bot systems.

**Source:** [Scraping Micro-Interactions - Tracking UX Experiments and A/B Variants | ScrapingAnt](https://scrapingant.com/blog/scraping-micro-interactions-tracking-ux-experiments-and-a-b)

---

## Column drift → the `columnShuffle` chaos mode

This is the sharpest failure mode in the benchmark, because it produces *wrong data*, not a crash — the exact split between the positional baseline (which fails `column-shuffle` / `site-v2` on validation) and the hybrid's header-name reader (which passes). The flagship citation is a real one from sports statistics: [baseballr PR #412](https://github.com/BillPetti/baseballr/pull/412), where Baseball Savant inserted a `miss_distance` column mid-table and a positional scraper silently mislabeled every column after it.

**Claim.** In a real, widely-used sports-stats R package (baseballr), Baseball Savant inserted a new mid-table column (miss_distance) rather than appending it at the end, which caused the scraper's positional column-renaming logic to silently mislabel roughly 26 subsequent columns of real data — with no crash or error thrown.

> Savant instead inserted `miss_distance` mid-frame at position 93, between `swing_length` and `estimated_slg_using_speedangle`. So the positional rename labeled column 93 (real `miss_distance` data) as `estimated_slg_using_speedangle` and shifted all 26 columns after it one position off: `miss_distance` never appeared, and the trailing bat-tracking columns were silently mislabeled

**Source:** [fix(statcast): recognize Savant's miss_distance column (#408) by cfarese · Pull Request #412 · BillPetti/baseballr · GitHub](https://github.com/BillPetti/baseballr/pull/412)

**Claim.** The bug report underlying that fix confirms a real sports-analytics site (Baseball Savant / MLB Statcast) added a new column to its data table, which is what triggered the downstream silent-mislabeling bug.

> It appears that Savant has added a 119th column (miss_distance) recently that needs to be added.

**Source:** [[Bug]: BaseballSavant added 119th column (miss_distance) · Issue #408 · BillPetti/baseballr · GitHub](https://github.com/BillPetti/baseballr/issues/408)

**Claim.** Playwright's official docs warn that positional locators like .nth() are unreliable because the page can change and the index will silently point at a different element than intended — a direct anti-pattern warning against positional/index-based selection.

> However, use this method with caution. Often times, the page might change, and the locator will point to a completely different element from the one you expected.

**Source:** [Locators | Playwright](https://playwright.dev/docs/locators)

**Claim.** A web-scraping engineering guide explicitly names index-based table selection (e.g. `tables[2]`) as a fragile anti-pattern that breaks specifically when a site's layout gains new blocks/columns above the target.

> Never select a table simply by calling tables[2]. Match by a unique caption, an ID, or a highly specific column header. Index-based selections break the moment the marketing team adds a new layout block above your target.

**Source:** [How to Extract Table Data From a Website Without Breakage](https://www.olostep.com/blog/extract-table-data-from-website)

**Claim.** The same guide separately identifies column-drift as a named failure mode: sites add columns, rename headers, and reorder cells without warning, and warns that missing values can shift an entire row's fields one column to the left undetected.

> Target sites add new columns, rename headers, and reorder cells without warning. Your pipeline needs to detect these shifts before downstream systems ingest bad records.

**Source:** [How to Extract Table Data From a Website Without Breakage](https://www.olostep.com/blog/extract-table-data-from-website)

---

## Maintenance burden → why this benchmark exists

The premise of the whole project — that selector scripts rot and cost engineering time — is not the author's opinion. It is stated plainly by the web-scraping industry itself, including Browserbase.

**Claim.** Bright Data (a major web-scraping/proxy company) states that scraper parsers are built on assumptions about a site's structure, so any structural change breaks the parser, and websites change structure without regard for scrapers.

> Your web scraping parsers are likely built on a set of assumptions on how the website is structured. It's necessary to extract just the content you need. However, it also means that any change to the structure renders your parser obsolete. Websites can change their structure without much consideration for web scrapers.

**Source:** [Web Scraping Challenges & Solutions](https://brightdata.com/blog/web-data/web-scraping-challenges)

**Claim.** Browserbase's engineering blog illustrates, via a worked example, how a brittle CSS-selector-based Playwright automation breaks the moment a site's developers rename a button's CSS class, forcing an engineer to lose an afternoon debugging and patching the script.

> The script works until the next week, when the HR portal's developers change the button's class name from "submit-btn" to "btn-primary". Her automation script grinds to a halt, forcing her to spend a frustrating afternoon debugging and fixing broken scripts rather than moving on to higher-value work.

**Source:** [The unbreakable web: From fragile scripts to bulletproof Workflows](https://www.browserbase.com/blog/temporal-browserbase)

**Claim.** Browserless.io's engineering blog states that because CSS/XPath selectors are tightly coupled to a page's exact DOM structure, even minor DOM changes break the selectors and require frequent scraper maintenance.

> This coupling means that even minor changes to the DOM can break the XPath, resulting in your scraper failing and needing frequent maintenance.

**Source:** [Patterns and Anti-Patterns in Web Scraping](https://www.browserless.io/blog/patterns-and-anti-patterns-in-web-scraping)

**Claim.** Apify's official engineering blog lists 'updating code whenever a site's layout changes' alongside figuring out CSS selectors and handling pagination as one of the recurring time/skill costs of building structured-data scrapers, and separately notes traditional scrapers 'break whenever a page is redesigned.'

> When you need to gather structured data from the web, there are things that can take a lot of time or skill. Things like figuring out CSS selectors, handling pagination logic, rotating proxies to avoid blocks, and updating code whenever a site's layout changes.

**Source:** [The best AI web scrapers in 2026? We put four to the test](https://blog.apify.com/best-ai-web-scrapers/)

---

## Sports sites churn → why this domain

The lab models a sports-stats + betting-odds site specifically because that domain is a documented worst case: non-standard markup, frequent redesigns, and timing-dependent corruption, admitted by the people who scrape them.

**Claim.** Sports-Reference sites (Basketball-Reference, Sports-Reference.com) render only the first stats table in normal page HTML; additional tables (per-40, per-100 possession, playoff splits) exist only inside HTML comments and are extracted client-side, so naive selector-based scraping silently returns data from the wrong table instead of erroring.

> The html for subsequent tables exists only in html comments and is somehow extracted before being rendered. Thus, when one attempts to scrape those tables, they instead only scrape stats from the first table.

**Source:** [GitHub - chrisfeller/Web_Scraping_Basketball_Reference](https://github.com/chrisfeller/Web_Scraping_Basketball_Reference)

**Claim.** A practitioner-built OddsPortal scraper's own documentation states outright that the odds/results site is a difficult scraping target, and separately documents timing-dependent bugs where insufficient wait time causes incorrect source URLs and missing late-season games — i.e. live/dynamic page state causing silent data corruption.

> The software is provided as-is. Odds Portal is a difficult website to scrape - thus the quirks/bugs disclosed earlier in this document.

**Source:** [odds-portal-scraper (full_scraper) README, gingeleski/odds-portal-scraper](https://github.com/gingeleski/odds-portal-scraper/blob/master/full_scraper/README.md)

**Claim.** A practitioner scraping Oddschecker (a betting-odds comparison site) documented that the site's frequent layout changes forced a migration from simple HTTP+BeautifulSoup parsing to full browser automation (Selenium) to keep the scraper working, with further code changes expected as the norm going forward.

> Although working today, Oddschecker frequently update their site layout as to discourage people from scraping.

**Source:** [Scraping Odds from Oddschecker using Python | by Riz Dusoye | Medium](https://dusoye.medium.com/scraping-odds-from-oddschecker-using-python-702742dd8106)

**Claim.** The author of betScrapeR, an R package combining Betfair exchange data with bookmaker odds scraped from odds-comparison sites, warns in the project's own README that the scraper is fragile to minor site changes and that any change to the scraped websites can break the entire package.

> Web scraping alogirithms are very sensitive to minor website changes (and my code is not immune to more general bugs).

**Source:** [GitHub - dashee87/betScrapeR: R package to scrape live sports betting odds](https://github.com/dashee87/betScrapeR)

---

## Stagehand features → the official patterns the engines exercise

The engines are not inventing techniques. The semantic Stagehand engine and the hybrid's `act`-cache / `observe`-repair design implement patterns that Stagehand and Browserbase document as intended usage.

**Claim.** Stagehand's official positioning is that traditional selector-based frameworks (Playwright, Puppeteer) produce brittle scripts that break on UI changes, while pure AI agents are unpredictable — Stagehand's act/extract/observe/agent primitives exist to let developers choose how much AI to use to solve this tradeoff.

> Traditional frameworks like Playwright and Puppeteer force you to write brittle scripts that break with every UI change. Web agents promise to solve this with AI, but leave you at the mercy of unpredictable behavior.

**Source:** [Introducing Stagehand - Stagehand](https://docs.stagehand.dev/v3/first-steps/introduction)

**Claim.** act() is documented as enabling self-healing, deterministic automations that adapt when a website's structure changes, in place of hardcoded selectors.

> act enables Stagehand to perform individual actions on a web page. Use it to build self-healing and deterministic automations that adapt to website changes.

**Source:** [Act - Stagehand Docs](https://docs.stagehand.dev/v3/basics/act)

**Claim.** observe() is recommended as a caching/planning step: discover actionable elements once, then replay the resulting structured action deterministically via act() without further LLM calls, yielding a 2-3x speedup over separate act() calls.

> Discover all actions once, then execute without additional LLM calls. This approach is 2-3x faster than separate act() calls.

**Source:** [Observe - Stagehand Docs](https://docs.stagehand.dev/v3/basics/observe)

**Claim.** Stagehand's Browserbase-managed cache automatically caches every act() call server-side when running with env: 'BROWSERBASE', so repeated calls with identical inputs return instantly with zero LLM token cost.

> When you run Stagehand with env: "BROWSERBASE", every act() call is automatically cached on Browserbase's servers. Repeated calls with the same inputs return instantly without consuming any LLM tokens.

**Source:** [Caching Actions - Stagehand Docs](https://docs.stagehand.dev/v3/best-practices/caching)

**Claim.** Stagehand's agent() primitive converts a high-level natural-language task into a fully autonomous, multi-step browser workflow, configurable by LLM provider/model, custom instructions, and max steps, with DOM, Computer-Use-Agent (CUA), and Hybrid execution modes.

> agent turns high level tasks into fully autonomous browser workflows. You can customize the agent by specifying the LLM provider and model, setting custom instructions for behavior, and configuring max steps.

**Source:** [Agent - Stagehand](https://docs.stagehand.dev/v3/basics/agent)

**Claim.** Browserbase Contexts persist cookies, localStorage, IndexedDB and other site data across separate browser sessions, letting automations skip repeated logins instead of starting from a fresh, empty user data directory each run.

> By default, each Browserbase session starts with a fresh user data directory, so cookies and application data reset between sessions. With Contexts, you can reuse this data across sessions, making automation workflows more reliable and eliminating repeated logins.

**Source:** [Contexts - Browserbase Documentation](https://docs.browserbase.com/features/contexts)

**Claim.** Stagehand's own guidance for mixing deterministic code with AI actions is explicit: use natural-language AI actions for navigating unfamiliar pages, and use plain code when the exact action is already known; combined with auto-caching and self-healing, this lets automations run without LLM inference until the site changes and breaks the cached path.

> Choose when to write code vs. natural language: use AI when you want to navigate unfamiliar pages, and use code when you know exactly what you want to do.

**Source:** [GitHub - browserbase/stagehand: The SDK For Browser Agents](https://github.com/browserbase/stagehand)
