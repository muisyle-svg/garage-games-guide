# Garage Games event guide

A static, mobile-first website for the Garage Games event guidelines. Visitors need no account; the site works offline after the first visit.

Each event year has its own guide: its own How it works page, events and scores. Visitors pick the year from the year button next to the name at the top of every page. The website code lives in `src/` and `build.mjs`; you can edit or add a year without touching code.

## How the content is organized

```
content/
  settings.md            current_year: the year the site opens on and that gets the live scores
  shared/images/         images any year can use (the event button photo)
  years/
    2026/
      site.md            homepage steps, How it works page, general guidelines
      events/*.md        one file per event
      images/            this year's animations and photos (a file here replaces a shared one)
      slideshows/*.md    photo slideshow captions
      course.json        where each event sits on the course map (for the Scores page)
      scores.json        this year's final scores, once saved (see "Adding a new year")
```

Each year is published at its own address: `/2026/`, `/2026/guidelines/`, `/2026/scoreboard/`, `/2026/events/wall-d/`. The addresses without a year (`/`, `/guidelines/`, `/scoreboard/`, `/events/wall-d/`, and the old `/rules/`) send visitors on to the current year, so links, bookmarks and QR codes from before keep working and always show the latest guide. An event the current year doesn't have goes to the newest year that had it. A year that isn't the current one shows a note at the top with a link to the current year.

## Adding a new year

1. **Save the finished year's scores first**, before the scorekeeper uploads anything for the new year: run `sh tools/save-scores.sh 2026`, or on GitHub open the `live-scores` branch, download `scores.json` and upload it to `content/years/2026/`. Commit it. That year's Scores page then always shows those scores.
2. **Make the new year's folder**, for example `content/years/2027/`, with a `site.md` and an `events/` folder. Copy or reuse what you need from the year before (below).
3. **Keep it hidden while you work on it** by adding `hidden: true` to the new `site.md` front matter. A hidden year is built at `/2027/` for you to check but isn't in the year list. Remove the line when it's ready.
4. **Switch the site over** by changing `current_year` in `content/settings.md` to the new year. From then on the addresses without a year open the new guide, and the scorekeeper's live scores show on the new year's Scores page. Nothing changes in the scorekeeper app: it keeps uploading to the `live-scores` branch.
5. **Update the course map** for the Scores page: put the new `course.jpg` in the year's `images/` folder and a `course.json` listing where each event's bubble sits on it (copy last year's and move the numbers). Without a `course.json` the Scores page just leaves out the course animation.

### Reusing last year's content

Any `site.md`, event or slideshow file can start from last year's version with `from:` in its front matter:

```markdown
---
from: 2026        # start from 2026's file with the same name (e.g. 2026/events/wall-d.md)
points: 120       # anything set here replaces last year's value
---
```

Use `from: 2026/ring-toss` to start from a differently named file in the same folder (for a renamed event). The text comes from last year's file unless this file has its own text, in which case this file's text is used in full. Front matter fields are merged one by one.

Images don't need copying either: if an event or page names an image that isn't in the year's `images/` folder or `content/shared/images/`, the newest earlier year's copy is used. A slideshow file (`slideshows/discs.md`) and its photo folder are found the same way. Put an image in the year's own folder to replace it.

## Editing events

Each event is one Markdown file in the year's `events/` folder. The file name becomes the web address: `content/years/2026/events/wall-d.md` is served at `/2026/events/wall-d/`.

```markdown
---
title: 'Wall-D'
order: 4               # position on the homepage
points: 100
grace_period: 20       # seconds before points start dropping
points_per_second: 2   # points lost each second after the grace period
finish: auto           # button = press again to stop, auto = time recorded automatically, none = no finish
image: wall-d.svg      # file in the year's images/ folder
---

## Objective
## Setup
## Gameplay
## Additional Guidelines and Clarifications
```

- Use only the headings you have text for; empty sections are left out.
- Scoring is shown as badges under the title, built from `points`, `grace_period` (stopwatch), `points_per_second` (falling arrow) and `finish: auto` (auto-stop badge). `points_label` adds a "per hit" badge (the bonus round uses this).
- Sections appear in this order: Objective, Gameplay, Additional Guidelines and Clarifications, then Setup/Reset (collapsed). Every page has an "Expand all" button.
- Optional fields: `subtitle` (small label above the title), `bonus: true` (shows a Bonus badge instead of points), `image_alt` (otherwise the objective is used).

The homepage steps, the "How it works" page and the general guidelines are in the year's `site.md`.

## Animations

Each 2026 event has an animated SVG in `content/years/2026/images/`. They are generated by `tools/animations.mjs`, which keeps one shared backdrop, palette and figure so they match. Edit a scene there, then run:

```
node tools/animations.mjs 2026
```

The year picks which `images/` folder it writes to; new scenes for a new year can be added to the same file. Any image file (`.svg`, `.jpg`, `.png`, `.gif`) dropped into a year's `images/` folder and named in an event's `image:` field works too.

## Photo slideshows

An event can show a captioned photo slideshow under its animation. Wall-D uses `slideshow: discs` in its front matter, which reads the year's `slideshows/discs.md`: a `captions:` list paired in order with the photos in the year's `images/discs/` (sorted by file name). To change it, swap photos in that folder and keep the captions list in the same order. The build warns if the counts differ.

## Survey

A year can have a feedback survey on its own Survey tab (`/2026/survey/`). Set it in the year's `site.md` front matter:

```markdown
survey: EqKae4              # the Tally form id, or its link (https://tally.so/r/EqKae4)
survey_title: Survey        # optional, the page heading
survey_intro: Thanks for playing!   # optional, text above the form
```

The form is embedded from Tally, so it needs a connection and only shows once the form is published in Tally. A link under it opens the form in a new tab. A year without `survey:` has no Survey tab (a new year that starts `from: 2026` keeps 2026's survey unless it sets its own or `survey: ''`). `/survey/` goes to the current year's survey, or the newest earlier one.

## Live scores

Each year's Scores page (`/2026/scoreboard/`) shows the scorekeeper's leaderboards: the overall leaderboard (tap a name for that run's scorecard) and one leaderboard per event. Below the leaderboard, **Compare players** lets visitors pick up to four runs (shareable as `?compare=` with the last six characters of each run id) for event-by-event bars and a run race chart, and **How the events compare** ranks events hardest first. Events start at different points, so that board compares shares of each event's starting points, taken from the `points` front matter of the matching event file (matched by name). **On the course** plays the picked runs on the year's course map: each player walks between event bubbles following the start and finish times in `scores.json`. The map image, bubble centers (in pixels on the image) and the starting event are in the year's `course.json`; update them if the course image changes. `src/scoreboard.js` draws it all from the year's `scores.json`, refreshing every 30 seconds.

The scorekeeper app uploads `scores.json` to the `live-scores` branch whenever the standings change (at most once a minute; setup is in the garage_games repo, `docs/PUBLIC-SCOREBOARD.md`). That branch's "Live scores updated" workflow sets off the deploy workflow, which builds `main` and copies the latest `scores.json` into the current year's folder (`/2026/scores.json`), unless that year already has a saved `content/years/<year>/scores.json`. Nothing on `main` changes. Without a `scores.json` the page says scores appear once the games begin.

To preview the page locally, put a `scores.json` in `dist/2026/` after building.

## Building and previewing

```
npm install
npm run build      # writes the site to dist/
npm run preview    # builds and serves it at http://localhost:3000
```

## Publishing

Every push to `main` rebuilds and publishes to GitHub Pages through `.github/workflows/pages.yml`. Cloudflare Pages works too: build command `npm run build`, output folder `dist`.
