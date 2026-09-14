# Grid Import Card

A Home Assistant dashboard card showing your daily electricity import from the
grid for the last X days. It works from a **cumulative meter**, the kind that
only ever counts up, and takes each day's import as the counter's change across
that day. No `utility_meter` or template sensor needed.

![Grid Import Card](https://raw.githubusercontent.com/rumpushome/grid-import-card/main/images/preview.png)

**There are three layouts in one card,** chosen from a dropdown in the visual editor:

| `style` | What it is | Best for |
| --- | --- | --- |
| `meter` *(default)* | Instrument panel: hairline rules, boxed stat cells, and a stepped area chart with a dashed average line | Seeing the shape of the month at a glance |
| `calendar` | A heat grid laid out by weekday, five weeks of colour intensity | Spotting habits, like weekend spikes |
| `ledger` | One thin row per day, exact figures in a readable column, and the average as a vertical line | Reading actual numbers |

All three show the same figures: **today so far**, the **daily average** for the
period, and the **period total**.

## Install

### HACS

[![Open this repository in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=rumpushome&repository=grid-import-card&category=plugin)

Or add it by hand:
1. Go to **HACS → ⋮ → Custom repositories**.
2. Paste `https://github.com/rumpushome/grid-import-card` and choose type **Dashboard**.
3. Download **Grid Import Card**. HACS adds the dashboard resource for you.

### Manual

1. Download `grid-import-card.js` from the
   [latest release](https://github.com/rumpushome/grid-import-card/releases/latest)
   and copy it into `config/www/`.
2. **Settings → Dashboards → ⋮ → Resources → + Add Resource**
   - URL: `/local/grid-import-card.js?v=1`
   - Type: **JavaScript Module**
3. Hard-refresh, then **+ Add Card** → **Grid Import Card**.

> Bump the `?v=` number every time you replace the file, or the browser keeps
> serving the cached copy.

## Configuration

```yaml
type: custom:grid-import-card
entity: sensor.grid_import_total
```

Everything else is optional:

```yaml
type: custom:grid-import-card
entity: sensor.grid_import_total
style: meter          # meter | calendar | ledger
name: Grid import
days: 30
chart_height: 148
accent: "#f0a500"
round: 1
show_total: true
average_includes_today: false
week_start: sunday
animate: true
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `entity` | string | **required** | Cumulative grid import sensor. |
| `style` | string | `meter` | `meter`, `calendar` or `ledger`. |
| `name` | string | friendly name | Card title. |
| `days` | number | `30` | Days to show (2–92). |
| `chart_height` | number | `148` | Chart height. **`meter` only.** |
| `accent` | hex | `#f0a500` | Colour for the bars, fills and highlights. |
| `round` | number | `1` | Decimal places. Totals of 100 or more are always shown as whole numbers. |
| `unit` | string | sensor's unit | Override the displayed unit. |
| `show_total` | bool | `true` | Show the period total. |
| `average_includes_today` | bool | `false` | See below. |
| `week_start` | string | `sunday` | `sunday` or `monday`. **`calendar` only.** |
| `animate` | bool | `true` | Entry animations and the rolling number. |

### Why today is left out of the average

Today is only partly over. Averaging in a half-finished day pulls the average
down and makes every comparison look better than it is: the card would tell you
you're using less than you are. So the average covers **completed days only**,
and today is always shown separately, labelled "so far today".

The `meter` layout goes further and draws today's step **dashed** rather than
solid, so a part-day doesn't look like a day your usage collapsed.

Set `average_includes_today: true` if you'd rather have a plain average.

### Colour

`accent` drives everything. The label colour is worked out from it by blending
towards your theme's text colour: darker on a light theme, lighter on a dark
one. That keeps it readable in both without you setting two colours.

In the `calendar` layout, the two darkest shades switch their text to dark or
light depending on how bright the accent is, so the numbers stay readable on a
strongly coloured cell.

## Where the data comes from

Three sources, tried in order:

1. **Statistics with `change`.** Home Assistant returns the counter's change for
   each hour directly, and the card groups the hours into days in your browser's
   timezone.
2. **Statistics with `sum`.** Older versions don't report `change`, so the card
   works out the differences from the running sum itself.
3. **Raw recorder history,** if there are no statistics at all. Because the
   counter only goes up, a day's import is its value at the next midnight minus
   its value at this one. This only reaches back as far as `purge_keep_days`.

Sources 1 and 2 need `state_class: total_increasing`, which is what makes Home
Assistant keep long-term statistics. You can check in **Developer Tools → States**.

The card deliberately uses hourly rather than daily buckets. Daily buckets are
cut in the **server's** timezone while the card labels days in the **browser's**,
and the two can disagree.

### Today updates without a refetch

History is fetched again at most every 5 minutes, but the meter climbs all the
time, and waiting five minutes to see today move would be useless. So the card
notes the meter reading when it fetches, and adds however far it has moved since:

```
today = today_at_fetch + (current_reading − reading_at_fetch)
```

Today's figure ticks up with every sensor update while the bars, cells and axis
stay put, so the entry animations don't restart on every meter tick. If the
reading ever drops (a meter reset), the card falls back to the last fetched
figure rather than showing a negative day.

### Missing days vs zero

A day the recorder has nothing for is **unknown**, not zero. The `calendar` draws
it as an empty outlined cell, the `ledger` as a dash, and the `meter` leaves a
gap in its line. Days with genuinely no import are drawn as real zeros.

## Troubleshooting

**Card doesn't appear**
The resource isn't loading. Check the URL and that the type is *JavaScript
Module*. The browser console logs `GRID-IMPORT-CARD v1.0.2` when the card loads.

**Every day reads 0**
The sensor probably isn't cumulative. If it resets to 0 every night, the card sees
no net change across most days. Point it at the lifetime total instead.

**Only recent days have data**
There are no long-term statistics, so the card is using raw history, and your
recorder keeps less than `days` of it. Add `state_class: total_increasing`, and
statistics will build up from then on.

**Figures differ slightly from the Energy dashboard**
It's the day boundaries. This card starts each day at your browser's local
midnight. If your Home Assistant server runs in a different timezone, the Energy
dashboard's day may start at a different moment.

**The ledger is very tall**
That's expected, with one row per day. For 60 days or more, use `meter` or
`calendar`, which stay the same height whatever the range.

## Licence

[MIT](LICENSE)
