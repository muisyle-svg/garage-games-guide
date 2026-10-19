# Garage Games 2025 event guide: analysis and plan

Source: the Google Slides deck "Garage Games 2025" (event rules). Status as of 2026-10-19: the deck's structure and rules were read through Google's public HTML view, which only returns paraphrases. **No wording below is verbatim yet.** The exact text and the slide images still need to come from a .pptx export or the Google Slides connector.

## 1. What the deck contains

| Part | Content |
|---|---|
| Overview | Title "Garage Games 2025 · Event Rules · More Like Guidelines Really". 13 stations, 5 minutes, points per completed event, bonus-per-second note, most points wins. |
| Buttons | One button per station. Press to start (red light blinks), press again when done (light turns green). Only press during your run. |
| General rules | Don't touch the buttons; stay out of the competitor's way; all 13 events must be completed; assistants advise only; no time or point penalties; "No Rep" means redo the failed part; head judge has final discretion. |
| Event list | 13 events with point values. Any order; you may abandon and return. |
| 13 event slides | Title, one illustration, a short joke caption, then 1 to 7 rule sentences. A few have a subtitle or flavor line. No slide uses section labels such as "Setup" or "Scoring". |

Event list, in slide order: Row Darts Redux 41.8 · PDGA Jam 31.4 · Paddle Peril 46.1 · Monkey Business 15.4 · A Few Good Pints 46.1 · Spice Slide 64.6 · Hook, Line, and Winner 75.0 · Top Shelf Shot 38.9 · Measure Up 53.9 · Bocce the Moon 64.6 · Perfect Pour 35.4 · Uphole Battle 53.9 · Hammerhead 10.0.

Note: the event slides are not in the same order as the event list (for example, Perfect Pour's slide comes right after PDGA Jam). The site uses the event list order.

## 2. Event data structure

One Markdown file per event in `content/events/`, separate from the site code. Front matter holds the facts; the body holds the rules under five fixed headings.

| Field | Required | Meaning |
|---|---|---|
| `title` | yes | Event name exactly as on the slide |
| `order` | no | Position on the homepage (event list order) |
| `points` | no | Point value from the event list |
| `image`, `image_alt` | no | Slide illustration in `content/images/`, and a description for screen readers |
| `caption` | no | The joke line under the slide image, kept as written |
| `subtitle` | no | Flavor line some slides have (e.g. "The harder version of Paddle Waddle from last year") |
| `wording` | no | `verbatim` once the text is copied exactly; `paraphrase` until then |
| `source_slide` | no | Slide number, for checking against the deck |
| `flags` | no | Missing or unclear points, shown in a "Needs clarification" box |

Body headings: `Objective`, `Setup`, `Gameplay`, `Scoring`, `Additional rules`.

Mapping rule for the migration: **every slide sentence goes into exactly one section, word for word**. Nothing is reworded to fit a section, and nothing is written to fill an empty one. An empty section displays "Not stated in the original guide." The only added text is the Objective line where the slide implies one; those lines should be reviewed (see section 5).

`content/site.md` holds the overview, buttons, general rules and event order text. `content/lineup.json` holds the event list until every event has its own file.

## 3. Visual design

- **Look:** garage and arcade. Warm charcoal in dark mode, warm off-white in light mode (follows the phone's setting), safety-yellow accent, a hazard-stripe rule under the header, bold condensed uppercase headings, point values in yellow pills.
- **Homepage:** title and tagline, quick facts (13 stations, 5 minutes, most points wins), a "How it works" button, a search box, then a grid of illustrated event cards (one column on phones, up to four on desktop).
- **Event page:** large illustration with its caption, points, then the five sections as cards that expand and collapse (Additional rules starts collapsed; "Expand all" button), the clarification box, and previous/next links.
- **How it works:** overview, buttons, general rules, event order and the full event table.
- **Search:** typing filters the cards and lists matches with the section name and a highlighted snippet; results link straight to the section, which opens automatically. Searches are shareable (`?q=green+hole`).
- **Speed and offline:** no frameworks, system fonts, about 15 KB of CSS and JS. A service worker saves the whole guide on first visit, so it keeps working with no signal in the garage.
- **Accessibility:** skip link, landmarks, real headings inside disclosure summaries, visible focus rings, AA contrast in both themes, alt text fields, reduced-motion support, print styles that expand every section.

## 4. Migration plan

1. **Get the source.** Export the deck as .pptx (File > Download > Microsoft PowerPoint) into `Documents\Garage Games`, or connect Google Slides. Extract text per slide with a script, and save each slide's illustration at full resolution.
2. **Replace the three prototype events' text** with the exact wording and set `wording: verbatim`. Confirm the mapping into sections reads well.
3. **Answer the flags** below that you want resolved on the site. Anything left open stays visible in its box, or can be hidden for launch with `show_flags: false`.
4. **Convert the remaining ten events** with the same script, one file each, then review them side by side with the slides (a checklist page listing every slide sentence and where it landed).
5. **Write alt text** for each illustration.
6. **Publish:** create a GitHub repository, push, enable Pages with GitHub Actions. Cloudflare Pages works with the same build.
7. **Before the event:** load the site once on each phone used at the stations so it is saved offline.

## 5. Flags: missing or ambiguous instructions

General
- Bonus points per second under 5:00 are described, but the same slide says there are no bonuses this year.
- "All 13 events must be completed, no skipping" conflicts with "you may abandon an event and come back".
- What happens when time runs out mid-event is not stated.
- "Don't touch the buttons" (general rules) sits next to "press the button to start" (buttons slide); presumably it means other stations' buttons or outside your run.

Per event
- **Row Darts Redux:** number of darts not stated; whether each throw needs a fresh push-off is not stated; whether one hit completes the event is not stated.
- **PDGA Jam:** says the event "goes outside" but you throw from inside the garage; "one shot" may mean one attempt total or one throw at a time until made.
- **Paddle Peril:** not stated whether you must also show control at the red line; what happens if the paddle falls (restart from the wall?).
- **Monkey Business:** where the three pieces start is not stated.
- **A Few Good Pints:** the score or level to beat is "not yet determined"; machine and controls not stated; slide typo "undermined".
- **Spice Slide:** not stated what counts as "in" the blue-tape zone (any overlap, or fully inside); whether a fallen spice can be reset.
- **Hook, Line, and Winner:** line distance and number of attempts not stated.
- **Top Shelf Shot:** where to throw from is only "in front of the bar"; whether a ball that bounces out counts.
- **Measure Up:** size and marking of the finish zone not stated; slide typo "it's area".
- **Bocce the Moon:** "Green *" asterisk has no footnote; "to win" conflicts with points-per-event scoring; ball start position and what happens in a non-green hole not stated.
- **Perfect Pour:** what the scale target is when the cup is included (the 12 oz includes the cup) is clear, but the cup's own weight is not given; slide typo "tarre".
- **Hammerhead:** "flush" here vs "completely" elsewhere; what counts as "excessively" bent.
- **Uphole Battle:** throwing distance not stated, and the caption says it is "a little farther" than shown.
