# Garage Games event guide

A static, mobile-first website for the Garage Games event rules. Visitors need no account; the site works offline after the first visit.

Event text lives in `content/`. The website code lives in `src/` and `build.mjs`. You can edit events without touching code.

## Editing events

Each event is one Markdown file in `content/events/`. The file name becomes the web address: `bocce-the-moon.md` is served at `/events/bocce-the-moon/`.

```markdown
---
title: Bocce the Moon
order: 10              # position on the homepage
points: 64.6
image: bocce-the-moon.jpg          # file in content/images/
image_alt: Two steel poles forming a ramp with a ball rolling uphill
caption: Something seems wrong here.   # the funny line under the slide image
wording: verbatim      # verbatim = copied exactly from the slides; paraphrase = needs replacing
source_slide: 14        # optional: which slide it came from
flags:                 # open questions, shown in a "Needs clarification" box
  - Where the ball starts is not stated.
---

## Objective
## Setup
## Gameplay
## Scoring
## Additional rules
```

- Use only the headings you have text for. A missing section shows "Not stated in the original guide." so gaps stay visible instead of being filled in.
- Points are shown automatically under Scoring.
- Additional rules start collapsed; the others start open. Every page has an "Expand all" button.
- Any other `## Heading` is shown after the standard ones.
- Put images in `content/images/`. Without one, the build draws a placeholder.

The general rules, buttons and event list are in `content/site.md` and `content/lineup.json`. Set `show_flags: false` in `content/site.md` to hide every "Needs clarification" box before the event.

## Building and previewing

```
npm install
npm run build      # writes the site to dist/
npm run preview    # builds and serves it at http://localhost:3000
```

## Publishing

On GitHub, enable Pages with "GitHub Actions" as the source (Settings > Pages). Every push to `main` rebuilds and publishes through `.github/workflows/pages.yml`.

Cloudflare Pages works too: build command `npm run build`, output folder `dist`.
