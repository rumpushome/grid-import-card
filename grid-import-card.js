/*!
 * Grid Import Card for Home Assistant
 * Daily electricity grid import for the last X days, from a cumulative meter.
 *
 * One card, three selectable layouts:
 *   style: meter     - instrument panel with a stepped area chart
 *   style: calendar  - weekday-aligned heat calendar
 *   style: ledger    - one row per day with exact figures
 *
 * Built for a counter that only ever increments. Daily import is the counter's
 * change across each day - no utility_meter or template sensor needed.
 *
 * No build step required - drop this file in /config/www/ and add it as a
 * Lovelace resource of type "JavaScript Module".
 *
 * Minimal usage:
 *   type: custom:grid-import-card
 *   entity: sensor.grid_import_total
 */

const CARD_VERSION = "1.0.2";
const DEFAULT_ACCENT = "#f0a500";
const STYLES = ["meter", "calendar", "ledger"];

/* ------------------------------------------------------------------ *
 * Colour helpers
 * ------------------------------------------------------------------ */

function hexToRgb(hex) {
  const h = String(hex).replace("#", "").trim();
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(h)) return null;
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function rgba(rgb, alpha) {
  return "rgba(" + rgb[0] + ", " + rgb[1] + ", " + rgb[2] + ", " + alpha + ")";
}

// Perceived brightness, used to decide whether text on a filled cell should be
// dark or light. Standard sRGB luma coefficients.
function luminance(rgb) {
  return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
}

/* ------------------------------------------------------------------ *
 * Misc helpers
 * ------------------------------------------------------------------ */

function localDayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + d;
}

function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[c]));
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

class GridImportCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._days = [];
    this._loading = true;
    this._error = null;
    this._lastFetch = 0;
    this._fetchPending = false;
    this._animateNext = true;
    this._source = null;
    // Live "today" tracking: the counter reading at fetch time, and today's
    // total as of that same moment.
    this._rawAtFetch = null;
    this._todayAtFetch = 0;
    this._axisTop = null;
    this._shownToday = null;
    this._countRaf = null;
    this._countTimer = null;
  }

  static getConfigElement() {
    return document.createElement("grid-import-card-editor");
  }

  static getStubConfig(hass) {
    let entity = "sensor.grid_import_total";
    if (hass && hass.states) {
      const ids = Object.keys(hass.states).filter((id) => id.startsWith("sensor."));
      const energy = ids.filter(
        (id) => hass.states[id].attributes.device_class === "energy"
      );
      const named = energy.filter((id) => /import|grid|consum|from_grid/i.test(id));
      entity = named[0] || energy[0] || entity;
    }
    return { type: "custom:grid-import-card", entity, days: 30, style: "meter" };
  }

  setConfig(config) {
    if (!config || !config.entity) {
      throw new Error("You need to define an entity, e.g. sensor.grid_import_total");
    }
    const days = Math.max(2, Math.min(92, Number(config.days === undefined ? 30 : config.days)));
    const style = STYLES.indexOf(config.style) >= 0 ? config.style : "meter";
    this._config = Object.assign(
      {
        name: null,
        chart_height: 148,
        show_total: true,
        show_labels: true,
        animate: true,
        round: 1,
        unit: null,
        accent: DEFAULT_ACCENT,
        week_start: "sunday",
        average_includes_today: false,
      },
      config,
      { days, style }
    );
    this._days = [];
    this._loading = true;
    this._error = null;
    this._lastFetch = 0;
    this._animateNext = true;
    this._shownToday = null;
    if (this._hass) this._maybeFetch(true);
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    const prev = this._stateObj();
    this._hass = hass;
    if (!this._config) return;
    if (first) {
      this._maybeFetch(true);
      return;
    }
    this._maybeFetch(false);
    // The counter climbs all day. Today's figure is derived locally from how far
    // it has moved since the last fetch, so it ticks up without a round trip -
    // and without rebuilding the DOM and restarting every animation.
    if (prev !== this._stateObj()) this._updateLive();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (this._config && this._hass) this._maybeFetch(false);
  }

  disconnectedCallback() {
    this._stopCount();
  }

  getCardSize() {
    if (!this._config) return 6;
    if (this._config.style === "ledger") return Math.ceil((this._config.days * 15 + 90) / 50);
    if (this._config.style === "calendar") return 7;
    return Math.ceil(this._config.chart_height / 50) + 3;
  }

  getGridOptions() {
    const cols = this._config && this._config.style === "calendar" ? 8 : 12;
    // "auto" lets the sections view measure the real rendered height. A fixed
    // row count guesses it, which shows up as dead space under a short card or
    // the next card overlapping a tall one.
    return { columns: cols, min_columns: 6, rows: "auto" };
  }

  /* ---------------------------- data ---------------------------- */

  _maybeFetch(force) {
    const now = Date.now();
    if (!force && now - this._lastFetch < 5 * 60 * 1000) return;
    if (this._fetchPending) return;
    this._fetchPending = true;
    this._lastFetch = now;
    this._fetchHistory()
      .then((days) => {
        this._days = days;
        this._loading = false;
        this._error = null;
      })
      .catch((err) => {
        console.error("grid-import-card:", err);
        this._error = (err && err.message) || String(err);
        this._loading = false;
      })
      .then(() => {
        this._fetchPending = false;
        this._animateNext = true;
        this._render();
      });
  }

  async _fetchHistory() {
    const hass = this._hass;
    const entity = this._config.entity;
    const days = this._config.days;

    const end = new Date();
    const windowStart = startOfLocalDay(new Date());
    windowStart.setDate(windowStart.getDate() - (days - 1));
    // One extra day of lead-in: deriving totals from a running sum needs the
    // bucket immediately before the first day we display.
    const queryStart = new Date(windowStart);
    queryStart.setDate(queryStart.getDate() - 1);

    const totals = new Map();
    const bump = (key, amount) => {
      if (!Number.isFinite(amount)) return;
      // A meter reset would otherwise land as a large negative day.
      totals.set(key, (totals.get(key) || 0) + Math.max(0, amount));
    };

    let ok = false;
    try {
      const stats = await hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: queryStart.toISOString(),
        end_time: end.toISOString(),
        statistic_ids: [entity],
        period: "hour",
        types: ["change", "sum", "state"],
      });
      const rows = (stats && stats[entity]) || [];
      if (rows.length) {
        // Number(null) is 0, not NaN, so nulls must be excluded explicitly or an
        // absent field reads as a real zero.
        const isNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
        const changeRows = rows.filter((r) => isNum(r.change));
        const sumRows = rows.filter((r) => isNum(r.sum));
        // Only trust "change" when every bucket carries one; a partial set would
        // silently score the missing buckets as zero import.
        const useChange = changeRows.length === rows.length;
        if (useChange || (changeRows.length && sumRows.length < 2)) {
          for (const row of changeRows) {
            bump(localDayKey(new Date(row.start)), Number(row.change));
          }
          this._source = useChange ? "statistics/change" : "statistics/change (partial)";
          ok = true;
        } else if (sumRows.length >= 2) {
          // Older cores do not report "change" - difference the running sum.
          let prevSum = null;
          for (const row of sumRows) {
            const sum = Number(row.sum);
            if (prevSum !== null) bump(localDayKey(new Date(row.start)), sum - prevSum);
            prevSum = sum;
          }
          this._source = "statistics/sum";
          ok = true;
        }
      }
    } catch (err) {
      ok = false;
    }

    // Fallback: raw recorder history. The counter is monotonic, so a day's
    // import is its value at the next midnight minus its value at this one.
    if (!ok) {
      const hist = await hass.callWS({
        type: "history/history_during_period",
        start_time: queryStart.toISOString(),
        end_time: end.toISOString(),
        entity_ids: [entity],
        minimal_response: true,
        no_attributes: true,
      });
      const rows = (hist && hist[entity]) || [];
      const points = [];
      for (const row of rows) {
        const raw = row.s === undefined ? row.state : row.s;
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        const ts = row.lu || row.last_updated || row.last_changed;
        const when = new Date(typeof ts === "number" ? ts * 1000 : ts);
        points.push({ t: when.getTime(), v: value });
      }
      points.sort((a, b) => a.t - b.t);
      const valueAt = (time) => {
        let found = null;
        for (const p of points) {
          if (p.t <= time) found = p.v;
          else break;
        }
        return found;
      };
      for (let i = 0; i < days; i++) {
        const dayStart = startOfLocalDay(new Date());
        dayStart.setDate(dayStart.getDate() - (days - 1 - i));
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);
        const a = valueAt(dayStart.getTime());
        const b = valueAt(Math.min(dayEnd.getTime(), Date.now()));
        if (a === null || b === null) continue;
        bump(localDayKey(dayStart), b - a);
      }
      this._source = "history";
    }

    const todayKey = localDayKey(new Date());
    const out = [];
    for (let i = 0; i < days; i++) {
      const date = startOfLocalDay(new Date());
      date.setDate(date.getDate() - (days - 1 - i));
      const key = localDayKey(date);
      // A day the recorder has nothing for is unknown, not zero.
      const total = totals.has(key) ? totals.get(key) : null;
      out.push({ date, key, total, isToday: key === todayKey });
    }

    // Anchor the live-update maths to this moment.
    this._rawAtFetch = this._rawValue();
    const last = out[out.length - 1];
    this._todayAtFetch = last && last.isToday && last.total !== null ? last.total : 0;
    return out;
  }

  /* --------------------------- helpers --------------------------- */

  _stateObj() {
    if (!this._config || !this._hass || !this._hass.states) return undefined;
    return this._hass.states[this._config.entity];
  }

  _rawValue() {
    const st = this._stateObj();
    if (!st) return null;
    const v = Number(st.state);
    return Number.isFinite(v) ? v : null;
  }

  _unit() {
    if (this._config.unit) return this._config.unit;
    const st = this._stateObj();
    return (st && st.attributes && st.attributes.unit_of_measurement) || "kWh";
  }

  _digits() {
    return Math.max(0, Math.min(3, Number(this._config.round === undefined ? 1 : this._config.round)));
  }

  _fmt(v, digits) {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    return Number(v).toFixed(digits === undefined ? this._digits() : digits);
  }

  // Big totals do not need decimals; they just get noisy.
  _fmtTotal(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    return Math.abs(v) >= 100 ? Math.round(v).toString() : this._fmt(v);
  }

  _accentRgb() {
    return hexToRgb(this._config.accent) || hexToRgb(DEFAULT_ACCENT);
  }

  // Today, brought up to date from how far the counter has moved since the
  // last history fetch.
  _todayValue() {
    const last = this._days.length ? this._days[this._days.length - 1] : null;
    if (!last || !last.isToday) return null;
    const raw = this._rawValue();
    if (raw === null || this._rawAtFetch === null) return last.total;
    const moved = raw - this._rawAtFetch;
    // A drop means the meter reset; trust the fetched figure until the next one.
    if (moved < 0) return last.total;
    return this._todayAtFetch + moved;
  }

  // Daily values with today replaced by its live figure.
  _series() {
    const out = this._days.map((d) => d.total);
    if (out.length) {
      const live = this._todayValue();
      if (live !== null) out[out.length - 1] = live;
    }
    return out;
  }

  _stats() {
    const series = this._series();
    const complete = this._config.average_includes_today ? series : series.slice(0, -1);
    const known = complete.filter((v) => v !== null);
    const all = series.filter((v) => v !== null);
    return {
      series,
      today: this._todayValue(),
      average: known.length ? known.reduce((a, b) => a + b, 0) / known.length : null,
      total: all.length ? all.reduce((a, b) => a + b, 0) : null,
      peak: all.length ? Math.max.apply(null, all) : 0,
      low: all.length ? Math.min.apply(null, all) : 0,
      countedDays: known.length,
    };
  }

  // Snapped so the axis does not twitch every time the meter ticks.
  _axisTopFor(peak) {
    const step = peak > 40 ? 10 : peak > 8 ? 5 : 1;
    return Math.max(step, Math.ceil((peak * 1.12) / step) * step);
  }

  /* --------------------------- rendering --------------------------- */

  _render() {
    if (!this._config) return;
    const animate = this._animateNext && this._config.animate !== false;
    this._animateNext = false;
    const rgb = this._accentRgb();
    const vars =
      ":host{--gi-accent:" + this._config.accent + ";--gi-accent-rgb:" +
      rgb.join(",") + ";}";
    this.shadowRoot.innerHTML =
      "<style>" + vars + GridImportCard.styles + "</style>" + this._html(animate);
    const open = () => this._showMore();
    this.shadowRoot.querySelectorAll("[data-more]").forEach((el) =>
      el.addEventListener("click", open)
    );
    this._shownToday = this._todayValue();
  }

  _showMore() {
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId: this._config.entity },
        bubbles: true,
        composed: true,
      })
    );
  }

  _html(animate) {
    const cfg = this._config;
    const st = this._stateObj();
    if (!st) {
      return '<ha-card><div class="pad err">Entity <code>' + escapeHtml(cfg.entity) + "</code> not found.</div></ha-card>";
    }
    if (this._error) {
      return '<ha-card><div class="pad err">Could not load history: ' + escapeHtml(this._error) + "</div></ha-card>";
    }
    if (this._loading) {
      return '<ha-card><div class="pad dim">Loading grid import…</div></ha-card>';
    }
    const s = this._stats();
    if (cfg.style === "calendar") return this._renderCalendar(s, animate);
    if (cfg.style === "ledger") return this._renderLedger(s, animate);
    return this._renderMeter(s, animate);
  }

  _title() {
    const st = this._stateObj();
    return (
      this._config.name ||
      (st && st.attributes && st.attributes.friendly_name) ||
      "Grid import"
    );
  }

  _todayCaption() {
    const d = this._days.length ? this._days[this._days.length - 1].date : new Date();
    return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  }

  /* ------------------------- style: meter ------------------------- */

  _meterGeometry(series, axisTop) {
    const W = 300;
    const H = 100;
    const n = series.length;
    const cw = W / n;
    const y = (v) => H - (Math.max(0, Math.min(v, axisTop)) / axisTop) * H;

    // Complete days form the solid run; today is drawn separately because it is
    // still filling up, and a solid step there would read as a day where usage
    // collapsed.
    const N = n - 1;
    let line = "";
    let started = false;
    for (let i = 0; i < N; i++) {
      const v = series[i];
      if (v === null) { started = false; continue; }
      const x0 = i * cw, x1 = (i + 1) * cw, yy = y(v).toFixed(2);
      line += (started ? " L " : " M ") + x0.toFixed(2) + "," + yy + " L " + x1.toFixed(2) + "," + yy;
      started = true;
    }
    // The filled area only makes sense as one continuous shape, so it is built
    // from the first known day to the last, skipping gaps in the outline.
    let area = "";
    const known = [];
    for (let i = 0; i < N; i++) if (series[i] !== null) known.push(i);
    if (known.length) {
      const a = known[0], b = known[known.length - 1];
      area = "M " + (a * cw).toFixed(2) + "," + H;
      for (let i = a; i <= b; i++) {
        const v = series[i] === null ? 0 : series[i];
        const yy = y(v).toFixed(2);
        area += " L " + (i * cw).toFixed(2) + "," + yy + " L " + ((i + 1) * cw).toFixed(2) + "," + yy;
      }
      area += " L " + ((b + 1) * cw).toFixed(2) + "," + H + " Z";
    }

    const tv = series[n - 1];
    const ty = tv === null ? null : y(tv).toFixed(2);
    const tx0 = (N * cw).toFixed(2);
    const partial = ty === null ? "" : "M " + tx0 + "," + ty + " L " + W + "," + ty;
    const partialArea =
      ty === null ? "" : "M " + tx0 + "," + ty + " L " + W + "," + ty + " L " + W + "," + H + " L " + tx0 + "," + H + " Z";

    return { W, H, cw, n, N, line, area, partial, partialArea, axisTop };
  }

  _renderMeter(s, animate) {
    const cfg = this._config;
    const unit = this._unit();
    const axisTop = this._axisTopFor(Math.max(s.peak, s.average || 0));
    this._axisTop = axisTop;
    const g = this._meterGeometry(s.series, axisTop);
    this._geom = g;

    const step = axisTop > 40 ? 10 : axisTop > 8 ? 5 : 1;
    let grid = "";
    for (let v = 0; v <= axisTop; v += step) {
      grid +=
        '<div class="gl' + (v === 0 ? " solid" : "") + '" style="top:' +
        ((1 - v / axisTop) * 100).toFixed(2) + '%"><span class="n">' + v + "</span></div>";
    }

    const ticks = [0, Math.floor(g.n / 3), Math.floor((g.n * 2) / 3), g.n - 1]
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((i) => {
        const isLast = i === g.n - 1;
        const txt = isLast
          ? "Today"
          : this._days[i].date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
        const pos = ((i + 0.5) / g.n) * 100;
        const style = i === 0
          ? "left:0"
          : isLast
          ? "right:0"
          : "left:" + pos.toFixed(2) + "%;transform:translateX(-50%)";
        return '<span style="' + style + '">' + escapeHtml(txt) + "</span>";
      })
      .join("");

    const avgTop = s.average === null ? null : ((1 - s.average / axisTop) * 100).toFixed(2);

    return (
      '<ha-card class="s-meter' + (animate ? " anim" : "") + '">' +
        '<div class="m-head" data-more>' +
          '<div class="m-now">' +
            '<div class="m-label">' + escapeHtml(this._title()) + " · today</div>" +
            '<div class="m-big"><span class="v mono" data-live="today">' +
              this._fmt(s.today) + '</span><span class="u">' + escapeHtml(unit) + "</span></div>" +
            '<div class="m-sub"><span class="dot"></span>so far today · ' +
              escapeHtml(this._todayCaption()) + "</div>" +
          "</div>" +
          '<div class="m-stats">' +
            '<div class="m-stat"><div class="k">Daily avg</div><div class="v mono">' +
              this._fmt(s.average) + "<small>" + escapeHtml(unit) + "</small></div></div>" +
            (cfg.show_total
              ? '<div class="m-stat"><div class="k">' + cfg.days + '-day total</div><div class="v mono" data-live="total">' +
                this._fmtTotal(s.total) + "<small>" + escapeHtml(unit) + "</small></div></div>"
              : "") +
          "</div>" +
        "</div>" +
        '<div class="m-chart" style="height:' + Number(cfg.chart_height) + 'px" data-more>' +
          grid +
          '<div class="m-svg"><svg viewBox="0 0 ' + g.W + " " + g.H + '" preserveAspectRatio="none">' +
            '<defs><linearGradient id="gi-fill" x1="0" y1="0" x2="0" y2="1">' +
              '<stop offset="0%" stop-color="var(--gi-accent)" stop-opacity="0.42"/>' +
              '<stop offset="100%" stop-color="var(--gi-accent)" stop-opacity="0.03"/>' +
            "</linearGradient></defs>" +
            '<path class="area" d="' + g.area + '" fill="url(#gi-fill)"/>' +
            '<path class="parea" d="' + g.partialArea + '" fill="url(#gi-fill)" opacity="0.4"/>' +
            '<path class="line" d="' + g.line + '" fill="none" stroke="var(--gi-accent)" ' +
              'stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>' +
            '<path class="pline" d="' + g.partial + '" fill="none" stroke="var(--gi-accent)" ' +
              'stroke-width="1.5" stroke-dasharray="3 2.5" vector-effect="non-scaling-stroke"/>' +
          "</svg></div>" +
          '<div class="todayline" style="left:' + (((g.n - 0.5) / g.n) * 100).toFixed(2) + '%"></div>' +
          (avgTop === null
            ? ""
            : '<div class="avgline" style="top:' + avgTop + '%"><span class="badge">AVG</span></div>') +
        "</div>" +
        '<div class="m-x">' + ticks + "</div>" +
      "</ha-card>"
    );
  }

  /* ----------------------- style: calendar ------------------------ */

  _calendarShade(v, s) {
    const rgb = this._accentRgb();
    const span = s.peak - s.low || 1;
    const t = Math.max(0, Math.min(1, (v - s.low) / span));
    const bucket = Math.min(4, Math.floor(t * 5));
    const alphas = [0.14, 0.3, 0.5, 0.72, 0.95];
    return { bg: rgba(rgb, alphas[bucket]), bucket };
  }

  _renderCalendar(s, animate) {
    const cfg = this._config;
    const unit = this._unit();
    const rgb = this._accentRgb();
    // On the hottest cells the theme's own text colour washes out, so those flip
    // to ink chosen against the accent's own brightness.
    const hotInk = luminance(rgb) > 0.55 ? "#1a1206" : "#ffffff";
    const alphas = [0.14, 0.3, 0.5, 0.72, 0.95];

    const sunFirst = cfg.week_start !== "monday";
    const dowLabels = sunFirst
      ? ["S", "M", "T", "W", "T", "F", "S"]
      : ["M", "T", "W", "T", "F", "S", "S"];
    const offset = (d) => (sunFirst ? d.getDay() : (d.getDay() + 6) % 7);

    const cells = [];
    const lead = this._days.length ? offset(this._days[0].date) : 0;
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let i = 0; i < this._days.length; i++) cells.push(i);
    while (cells.length % 7 !== 0) cells.push(null);

    let weeks = "";
    for (let w = 0; w < cells.length / 7; w++) {
      weeks += '<div class="c-week">';
      for (let c = 0; c < 7; c++) {
        const i = cells[w * 7 + c];
        if (i === null) { weeks += '<div class="cell empty"></div>'; continue; }
        const v = s.series[i];
        const d = this._days[i];
        if (v === null) {
          weeks += '<div class="cell nodata" title="' + escapeHtml(d.date.toLocaleDateString()) +
            ': no data" style="animation-delay:' + (i * 0.012).toFixed(3) + 's">·</div>';
          continue;
        }
        const sh = this._calendarShade(v, s);
        weeks +=
          '<div class="cell' + (d.isToday ? " today" : "") + '"' +
          (d.isToday ? ' data-live="cell"' : "") +
          ' style="background:' + sh.bg + ";color:" + (sh.bucket >= 3 ? hotInk : "var(--primary-text-color)") +
          ";animation-delay:" + (i * 0.012).toFixed(3) + 's" title="' +
          escapeHtml(d.date.toLocaleDateString()) + ": " + this._fmt(v) + " " + escapeHtml(unit) + '">' +
          '<span class="n mono">' + Math.round(v) + "</span></div>";
      }
      weeks += "</div>";
    }

    const delta =
      s.average && s.today !== null ? ((s.today - s.average) / s.average) * 100 : null;

    return (
      '<ha-card class="s-calendar' + (animate ? " anim" : "") + '">' +
        '<div class="c-head" data-more>' +
          '<div class="c-now"><div class="k">' + escapeHtml(this._title()) + " · today</div>" +
            '<div class="v mono"><span data-live="today">' + this._fmt(s.today) +
            "</span><small>" + escapeHtml(unit) + "</small></div></div>" +
          '<div class="c-avg"><div class="k">Daily avg</div>' +
            '<div class="v mono">' + this._fmt(s.average) + "<small>" + escapeHtml(unit) + "</small></div>" +
            (delta === null
              ? ""
              : '<div class="c-delta ' + (delta < 0 ? "under" : "over") + '" data-live="delta">' +
                (delta < 0 ? "▼ " : "▲ ") + Math.abs(delta).toFixed(0) + "% vs avg</div>") +
          "</div>" +
        "</div>" +
        '<div class="c-grid" data-more>' +
          '<div class="c-dow">' + dowLabels.map((l) => "<div>" + l + "</div>").join("") + "</div>" +
          weeks +
        "</div>" +
        '<div class="c-legend"><span>' + Math.round(s.low) + "</span>" +
          alphas.map((a) => '<span class="sw" style="background:' + rgba(rgb, a) + '"></span>').join("") +
          "<span>" + Math.round(s.peak) + " " + escapeHtml(unit) + "</span></div>" +
      "</ha-card>"
    );
  }

  /* ------------------------ style: ledger ------------------------- */

  _renderLedger(s, animate) {
    const cfg = this._config;
    const unit = this._unit();
    const scale = Math.max(s.peak * 1.05, 0.001);

    let rows = "";
    for (let i = 0; i < this._days.length; i++) {
      const v = s.series[i];
      const d = this._days[i];
      const cls =
        "lr" + (v !== null && s.average !== null && v > s.average ? " over" : "") +
        (d.isToday ? " today" : "");
      const bar =
        v === null
          ? '<span class="b none"></span>'
          : '<span class="b" style="width:' + ((v / scale) * 100).toFixed(2) +
            "%;animation-delay:" + (i * 0.015).toFixed(3) + 's"></span>';
      rows +=
        '<div class="' + cls + '"' + (d.isToday ? ' data-live="row"' : "") + '>' +
        '<span class="d mono">' +
          escapeHtml(d.date.toLocaleDateString(undefined, { day: "2-digit", month: "short" })) +
        "</span>" +
        '<span class="t">' + bar + "</span>" +
        '<span class="n mono"' + (d.isToday ? ' data-live="today"' : "") + ">" +
          (v === null ? "–" : this._fmt(v)) + "</span>" +
        "</div>";
    }

    const avgLeft =
      s.average === null
        ? null
        : "calc(66px + (100% - 140px) * " + (s.average / scale).toFixed(4) + ")";

    return (
      '<ha-card class="s-ledger' + (animate ? " anim" : "") + '">' +
        '<div class="l-head" data-more>' +
          '<div class="l-cell hero"><div class="k">Today</div><div class="v mono">' +
            '<span data-live="today">' + this._fmt(s.today) + "</span><small>" + escapeHtml(unit) + "</small></div></div>" +
          '<div class="l-cell"><div class="k">Daily avg</div><div class="v mono">' +
            this._fmt(s.average) + "<small>" + escapeHtml(unit) + "</small></div></div>" +
          (cfg.show_total
            ? '<div class="l-cell"><div class="k">Total</div><div class="v mono" data-live="total">' +
              this._fmtTotal(s.total) + "<small>" + escapeHtml(unit) + "</small></div></div>"
            : "") +
        "</div>" +
        '<div class="l-rows" data-more>' + rows +
          (avgLeft === null
            ? ""
            : '<div class="l-avg" style="left:' + avgLeft + '"><span class="cap">AVG</span></div>') +
        "</div>" +
        '<div class="l-foot"><span>' +
          escapeHtml(this._days.length ? this._days[0].date.toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "") +
          "</span><span>" + cfg.days + " days</span><span>today</span></div>" +
      "</ha-card>"
    );
  }

  /* ----------------------- live (cheap) updates ---------------------- */

  _updateLive() {
    const root = this.shadowRoot;
    if (this._loading || this._error || !root.querySelector("ha-card")) {
      this._render();
      return;
    }
    const s = this._stats();

    // A scale change moves everything, so that needs a real redraw. Snapping the
    // axis keeps it rare.
    if (this._config.style === "meter") {
      const top = this._axisTopFor(Math.max(s.peak, s.average || 0));
      if (top !== this._axisTop) {
        this._render();
        return;
      }
    }

    // One call for every target: a layout can show today in more than one place
    // (the ledger repeats it in its own row), and separate calls would each
    // cancel the previous one's animation.
    this._animateNumber(root.querySelectorAll('[data-live="today"]'), s.today);
    const tot = root.querySelector('[data-live="total"]');
    if (tot) tot.textContent = this._fmtTotal(s.total);

    if (this._config.style === "meter") this._updateMeter(s);
    else if (this._config.style === "calendar") this._updateCalendar(s);
    else this._updateLedger(s);
  }

  _updateMeter(s) {
    const root = this.shadowRoot;
    const g = this._meterGeometry(s.series, this._axisTop);
    this._geom = g;
    const pl = root.querySelector("svg .pline");
    const pa = root.querySelector("svg .parea");
    if (pl) pl.setAttribute("d", g.partial);
    if (pa) pa.setAttribute("d", g.partialArea);
  }

  _updateCalendar(s) {
    const root = this.shadowRoot;
    const cell = root.querySelector('[data-live="cell"]');
    if (cell && s.today !== null) {
      const rgb = this._accentRgb();
      const hotInk = luminance(rgb) > 0.55 ? "#1a1206" : "#ffffff";
      const sh = this._calendarShade(s.today, s);
      cell.style.background = sh.bg;
      cell.style.color = sh.bucket >= 3 ? hotInk : "var(--primary-text-color)";
      const n = cell.querySelector(".n");
      if (n) n.textContent = Math.round(s.today);
    }
    const delta = root.querySelector('[data-live="delta"]');
    if (delta && s.average && s.today !== null) {
      const pct = ((s.today - s.average) / s.average) * 100;
      delta.className = "c-delta " + (pct < 0 ? "under" : "over");
      delta.textContent = (pct < 0 ? "▼ " : "▲ ") + Math.abs(pct).toFixed(0) + "% vs avg";
    }
  }

  _updateLedger(s) {
    const root = this.shadowRoot;
    const row = root.querySelector('[data-live="row"]');
    if (row && s.today !== null) {
      const bar = row.querySelector(".b");
      const scale = Math.max(s.peak * 1.05, 0.001);
      if (bar) bar.style.width = ((s.today / scale) * 100).toFixed(2) + "%";
      if (s.average !== null) row.classList.toggle("over", s.today > s.average);
    }
  }

  // Roll the headline number instead of snapping it. Accepts one element or a
  // collection - all targets share a single animation.
  _animateNumber(els, target) {
    this._stopCount();
    const list = els && typeof els.length === "number" ? Array.prototype.slice.call(els) : [els];
    const write = (txt) => list.forEach((el) => { if (el) el.textContent = txt; });
    if (!list.length) return;
    if (target === null) {
      write("–");
      this._shownToday = null;
      return;
    }
    const snap = () => {
      this._stopCount();
      write(this._fmt(target));
      this._shownToday = target;
    };
    const from = this._shownToday;
    const canAnimate =
      this._config.animate !== false &&
      from !== null &&
      Math.abs(target - from) >= 0.05 &&
      typeof requestAnimationFrame === "function" &&
      !(typeof document !== "undefined" && document.hidden);
    if (!canAnimate) {
      snap();
      return;
    }
    const duration = 550;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      const value = from + (target - from) * eased;
      write(this._fmt(value));
      // Track every frame so an interrupted run resumes from what is on screen.
      this._shownToday = value;
      if (p < 1) this._countRaf = requestAnimationFrame(step);
      else snap();
    };
    this._countRaf = requestAnimationFrame(step);
    // rAF stops in a hidden tab and is throttled on some wall displays; without
    // this the number would freeze part-way to its new value.
    this._countTimer = setTimeout(snap, duration + 150);
  }

  _stopCount() {
    if (this._countRaf) {
      cancelAnimationFrame(this._countRaf);
      this._countRaf = null;
    }
    if (this._countTimer) {
      clearTimeout(this._countTimer);
      this._countTimer = null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */

GridImportCard.styles = [
  ":host { display: block;",
  "  --gi-hair: var(--divider-color, rgba(127, 137, 150, 0.2));",
  "  --gi-faint: var(--disabled-text-color, var(--secondary-text-color));",
  "  --gi-cool: #58c9e8;",
  "  --gi-ink: var(--gi-accent); }",
  // Nudging the accent toward the theme's text colour darkens it on a light
  // theme and lightens it on a dark one, so the label stays readable on both.
  "@supports (color: color-mix(in srgb, red, blue)) {",
  "  :host { --gi-ink: color-mix(in srgb, var(--gi-accent), var(--primary-text-color) 28%); } }",

  "ha-card { padding: 0; overflow: hidden; }",
  ".pad { padding: 16px; }",
  ".dim { color: var(--secondary-text-color); }",
  ".err { color: var(--error-color, #db4437); }",
  ".mono { font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace;",
  "  font-variant-numeric: tabular-nums; }",

  "@keyframes gi-fade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }",
  "@keyframes gi-wipe { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }",
  "@keyframes gi-pop { from { opacity: 0; transform: scale(0.82); } to { opacity: 1; transform: none; } }",
  "@keyframes gi-slide { from { transform: scaleX(0); } to { transform: scaleX(1); } }",

  /* ---------------- meter ---------------- */
  ".s-meter .m-head { display: flex; align-items: stretch; border-bottom: 1px solid var(--gi-hair); cursor: pointer; }",
  ".s-meter .m-now { flex: 1 1 auto; padding: 15px 16px 13px; min-width: 0; }",
  ".s-meter .m-label { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase;",
  "  color: var(--gi-faint); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
  ".s-meter .m-big { display: flex; align-items: baseline; gap: 6px; margin-top: 7px; }",
  ".s-meter .m-big .v { font-size: 40px; line-height: 0.92; font-weight: 500; letter-spacing: -0.02em;",
  "  color: var(--primary-text-color); }",
  ".s-meter .m-big .u { font-size: 14px; color: var(--secondary-text-color); }",
  ".s-meter .m-sub { font-size: 11px; color: var(--gi-faint); margin-top: 7px; }",
  ".s-meter .m-sub .dot { display: inline-block; width: 5px; height: 5px; border-radius: 50%;",
  "  background: var(--gi-accent); margin-right: 5px; vertical-align: middle; }",
  ".s-meter .m-stats { display: flex; flex-direction: column; border-left: 1px solid var(--gi-hair); }",
  ".s-meter .m-stat { padding: 11px 15px; min-width: 116px; }",
  ".s-meter .m-stat + .m-stat { border-top: 1px solid var(--gi-hair); }",
  ".s-meter .m-stat .k { font-size: 9.5px; letter-spacing: 0.13em; text-transform: uppercase;",
  "  color: var(--gi-faint); font-weight: 600; }",
  ".s-meter .m-stat .v { font-size: 17px; margin-top: 4px; color: var(--primary-text-color); }",
  ".s-meter .m-stat .v small { font-size: 10px; color: var(--secondary-text-color); margin-left: 3px; }",

  ".s-meter .m-chart { position: relative; margin: 16px 46px 0 16px; cursor: pointer; }",
  ".s-meter .gl { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--gi-hair); }",
  ".s-meter .gl.solid { border-top-style: solid; }",
  ".s-meter .gl .n { position: absolute; right: -42px; top: -7px; width: 38px;",
  "  font-size: 10px; color: var(--gi-faint); }",
  ".s-meter .m-svg { position: absolute; inset: 0; }",
  ".s-meter .m-svg svg { width: 100%; height: 100%; display: block; }",
  ".s-meter .avgline { position: absolute; left: 0; right: 0; border-top: 1px dashed var(--gi-cool); }",
  ".s-meter .avgline .badge { position: absolute; right: 0; top: -8px; transform: translateY(-50%);",
  "  background: var(--card-background-color); color: var(--gi-cool); font-size: 9.5px;",
  "  font-weight: 700; letter-spacing: 0.1em; padding: 0 4px; }",
  ".s-meter .todayline { position: absolute; top: 0; bottom: 0; border-left: 1px solid var(--gi-accent); opacity: 0.55; }",
  ".s-meter .m-x { position: relative; height: 13px; margin: 7px 46px 15px 16px; }",
  ".s-meter .m-x span { position: absolute; top: 0; font-size: 10px; color: var(--gi-faint); white-space: nowrap; }",
  ".s-meter.anim .m-svg { animation: gi-wipe 0.9s cubic-bezier(0.22, 1, 0.36, 1) both; }",
  ".s-meter.anim .m-head { animation: gi-fade 0.45s ease-out both; }",

  /* ---------------- calendar ---------------- */
  ".s-calendar .c-head { padding: 15px 16px 12px; display: flex; align-items: flex-end; gap: 18px; cursor: pointer; }",
  ".s-calendar .k { font-size: 9.5px; letter-spacing: 0.14em; text-transform: uppercase;",
  "  color: var(--gi-faint); font-weight: 600; }",
  ".s-calendar .c-now { min-width: 0; }",
  ".s-calendar .c-now .v { font-size: 34px; line-height: 1; margin-top: 6px; font-weight: 500;",
  "  color: var(--primary-text-color); }",
  ".s-calendar .c-now .v small { font-size: 13px; color: var(--secondary-text-color); margin-left: 4px; }",
  ".s-calendar .c-avg { padding-bottom: 4px; border-left: 1px solid var(--gi-hair); padding-left: 18px; }",
  ".s-calendar .c-avg .v { font-size: 19px; margin-top: 5px; color: var(--primary-text-color); }",
  ".s-calendar .c-avg .v small { font-size: 10px; color: var(--secondary-text-color); margin-left: 3px; }",
  ".s-calendar .c-delta { font-size: 11px; margin-top: 5px; }",
  ".s-calendar .c-delta.under { color: var(--gi-cool); }",
  ".s-calendar .c-delta.over { color: var(--gi-ink); }",
  ".s-calendar .c-grid { padding: 4px 16px 0; cursor: pointer; }",
  ".s-calendar .c-dow, .s-calendar .c-week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }",
  ".s-calendar .c-dow div { font-size: 9.5px; color: var(--gi-faint); text-align: center;",
  "  padding-bottom: 5px; font-weight: 600; }",
  ".s-calendar .c-week { margin-bottom: 4px; }",
  ".s-calendar .cell { position: relative; aspect-ratio: 1 / 1; border-radius: 2px;",
  "  background: var(--gi-hair); display: flex; align-items: center; justify-content: center; }",
  ".s-calendar .cell .n { font-size: 10px; }",
  ".s-calendar .cell.empty { background: transparent; }",
  ".s-calendar .cell.nodata { background: transparent; color: var(--gi-faint);",
  "  box-shadow: 0 0 0 1px var(--gi-hair) inset; font-size: 12px; }",
  ".s-calendar .cell.today { box-shadow: 0 0 0 1.5px var(--gi-accent); }",
  ".s-calendar .c-legend { display: flex; align-items: center; gap: 6px; padding: 11px 16px 15px;",
  "  font-size: 10px; color: var(--gi-faint); }",
  ".s-calendar .c-legend .sw { width: 13px; height: 13px; border-radius: 2px; }",
  ".s-calendar.anim .cell { animation: gi-pop 0.4s ease-out both; }",
  ".s-calendar.anim .c-head { animation: gi-fade 0.45s ease-out both; }",

  /* ---------------- ledger ---------------- */
  ".s-ledger .l-head { display: flex; border-bottom: 1px solid var(--gi-hair); cursor: pointer; }",
  ".s-ledger .l-cell { padding: 12px 14px; flex: 1 1 0; min-width: 0; }",
  ".s-ledger .l-cell + .l-cell { border-left: 1px solid var(--gi-hair); }",
  ".s-ledger .l-cell .k { font-size: 9.5px; letter-spacing: 0.13em; text-transform: uppercase;",
  "  color: var(--gi-faint); font-weight: 600; }",
  ".s-ledger .l-cell .v { font-size: 22px; margin-top: 5px; color: var(--primary-text-color); }",
  ".s-ledger .l-cell .v small { font-size: 10px; color: var(--secondary-text-color); margin-left: 3px; }",
  ".s-ledger .l-cell.hero .v { color: var(--gi-ink); }",
  ".s-ledger .l-rows { padding: 9px 14px 14px; position: relative; cursor: pointer; }",
  ".s-ledger .lr { display: grid; grid-template-columns: 44px 1fr 52px; align-items: center;",
  "  gap: 8px; height: 15px; }",
  ".s-ledger .lr .d { font-size: 10px; color: var(--gi-faint); }",
  ".s-ledger .lr .t { position: relative; height: 7px; }",
  ".s-ledger .lr .b { position: absolute; left: 0; top: 0; bottom: 0; background: var(--gi-accent);",
  "  opacity: 0.4; transform-origin: left; }",
  ".s-ledger .lr .b.none { width: 0; }",
  ".s-ledger .lr.over .b { opacity: 0.95; }",
  ".s-ledger .lr .n { font-size: 10.5px; text-align: right; color: var(--secondary-text-color); }",
  ".s-ledger .lr.over .n { color: var(--primary-text-color); }",
  ".s-ledger .lr.today .d, .s-ledger .lr.today .n { color: var(--gi-ink); font-weight: 700; }",
  ".s-ledger .lr.today .b { opacity: 1; }",
  ".s-ledger .l-avg { position: absolute; top: 9px; bottom: 14px; border-left: 1px dashed var(--gi-cool); }",
  ".s-ledger .l-avg .cap { position: absolute; top: -9px; left: 3px; font-size: 9px;",
  "  color: var(--gi-cool); letter-spacing: 0.08em; font-weight: 700; }",
  ".s-ledger .l-foot { display: flex; justify-content: space-between; padding: 0 14px 12px;",
  "  font-size: 10px; color: var(--gi-faint); }",
  ".s-ledger.anim .lr .b { animation: gi-slide 0.5s cubic-bezier(0.22, 1, 0.36, 1) both; }",
  ".s-ledger.anim .l-head { animation: gi-fade 0.45s ease-out both; }",

  "@media (prefers-reduced-motion: reduce) {",
  "  .s-meter .m-svg, .s-meter .m-head, .s-calendar .cell, .s-calendar .c-head,",
  "  .s-ledger .lr .b, .s-ledger .l-head { animation: none !important; } }",
].join("\n");

/* ------------------------------------------------------------------ *
 * Visual editor
 * ------------------------------------------------------------------ */

const EDITOR_SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: ["sensor"] } } },
  {
    name: "style",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "meter", label: "Meter — stepped chart with average line" },
          { value: "calendar", label: "Calendar — weekday heat grid" },
          { value: "ledger", label: "Ledger — one row per day" },
        ],
      },
    },
  },
  {
    type: "grid",
    schema: [
      { name: "name", selector: { text: {} } },
      { name: "days", selector: { number: { min: 2, max: 92, mode: "box" } } },
      { name: "chart_height", selector: { number: { min: 80, max: 400, step: 10, mode: "box" } } },
      { name: "round", selector: { number: { min: 0, max: 3, mode: "box" } } },
      { name: "accent", selector: { text: {} } },
      { name: "unit", selector: { text: {} } },
    ],
  },
  {
    name: "week_start",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "sunday", label: "Sunday" },
          { value: "monday", label: "Monday" },
        ],
      },
    },
  },
  {
    type: "grid",
    schema: [
      { name: "show_total", selector: { boolean: {} } },
      { name: "average_includes_today", selector: { boolean: {} } },
      { name: "animate", selector: { boolean: {} } },
    ],
  },
];

const EDITOR_LABELS = {
  entity: "Cumulative grid import sensor (required)",
  style: "Layout",
  name: "Card title",
  days: "Days to show",
  chart_height: "Chart height (px) — meter only",
  round: "Decimal places",
  accent: "Accent colour (hex)",
  unit: "Unit override",
  week_start: "Week starts on — calendar only",
  show_total: "Show period total",
  average_includes_today: "Include today in the average",
  animate: "Animations",
};

class GridImportCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._form = null;
  }

  setConfig(config) {
    this._config = Object.assign({}, config);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      const form = document.createElement("ha-form");
      form.computeLabel = (schema) => EDITOR_LABELS[schema.name] || schema.name;
      form.addEventListener("value-changed", (ev) => {
        ev.stopPropagation();
        const next = Object.assign({}, ev.detail.value);
        Object.keys(next).forEach((k) => {
          if (next[k] === "" || next[k] === undefined || next[k] === null) delete next[k];
        });
        this._config = next;
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: next },
            bubbles: true,
            composed: true,
          })
        );
      });
      this.shadowRoot.appendChild(form);
      this._form = form;
    }
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = this._config;
    if (this._hass) this._form.hass = this._hass;
  }
}

customElements.define("grid-import-card", GridImportCard);
customElements.define("grid-import-card-editor", GridImportCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "grid-import-card",
  name: "Grid Import Card",
  description: "Daily electricity grid import from a cumulative meter, in three selectable layouts.",
  preview: true,
});

console.info(
  "%c GRID-IMPORT-CARD %c v" + CARD_VERSION + " ",
  "color: #1a1206; background: #f0a500; font-weight: 700;",
  "color: #f0a500; background: #222; font-weight: 700;"
);
