/* Canvas chart helpers — labelled, export-safe, dual-axis time series. */
window.GlobalCharts = (() => {
  "use strict";

  const COLORS = ["#38bdf8", "#f472b6", "#4ade80", "#fbbf24", "#a78bfa", "#fb923c"];
  const FONT = '"IBM Plex Mono", Consolas, monospace';

  function finiteValues(series) {
    return (series.points || []).map((point) => Number(point.v)).filter(Number.isFinite);
  }

  function scaleMagnitude(series) {
    const values = finiteValues(series);
    if (!values.length) return 0;
    const maxAbs = Math.max(...values.map(Math.abs));
    const range = Math.max(...values) - Math.min(...values);
    return Math.max(maxAbs, range);
  }

  function assignAxes(seriesList, defaultUnit = "") {
    const active = (seriesList || []).filter((series) => series.points?.length);
    if (active.length < 2) {
      return active.map((series) => ({ ...series, axis: series.axis || "left", unit: series.unit || defaultUnit }));
    }

    const primarySeries = active.find((series) => series.axis !== "right") || active[0];
    const primaryUnit = primarySeries?.unit || defaultUnit;
    const primaryMagnitude = scaleMagnitude(primarySeries) || 1;
    return active.map((series, index) => {
      if (series.axis === "left" || series.axis === "right") {
        return { ...series, unit: series.unit || defaultUnit };
      }
      const unit = series.unit || defaultUnit;
      const magnitude = scaleMagnitude(series);
      const differentUnit = Boolean(primaryUnit && unit && primaryUnit !== unit);
      const ratio = Math.max(primaryMagnitude, magnitude || 1) / Math.max(1e-9, Math.min(primaryMagnitude, magnitude || 1));
      return { ...series, unit, axis: index > 0 && (differentUnit || ratio >= 20) ? "right" : "left" };
    });
  }

  function niceStep(span, targetTicks = 5) {
    const rough = Math.max(1e-12, span / targetTicks);
    const power = 10 ** Math.floor(Math.log10(rough));
    const fraction = rough / power;
    const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return nice * power;
  }

  function axisScale(series) {
    const values = series.flatMap(finiteValues);
    if (!values.length) return { min: 0, max: 1, step: 0.2 };
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      const margin = Math.abs(min) * 0.08 || 1;
      min -= margin;
      max += margin;
    }
    const step = niceStep(max - min);
    min = Math.floor(min / step) * step;
    max = Math.ceil(max / step) * step;
    if (min === max) max += step;
    return { min, max, step };
  }

  function numberLabel(value, step) {
    const abs = Math.abs(value);
    if (abs >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (abs >= 10000) return `${(value / 1000).toFixed(0)}k`;
    const digits = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
    return value.toFixed(digits);
  }

  function timeLabel(timestamp, span) {
    const date = new Date(timestamp);
    const options = span > 86400000 * 3
      ? { month: "short", day: "numeric" }
      : { hour: "2-digit", minute: "2-digit" };
    return date.toLocaleString(undefined, options);
  }

  function wrappedLegendRows(ctx, active, maxWidth) {
    const rows = [[]];
    let used = 0;
    active.forEach((series, index) => {
      const label = `${series.label || `Series ${index + 1}`}${series.unit ? ` (${series.unit})` : ""}`;
      const width = 21 + ctx.measureText(label).width + 14;
      if (used && used + width > maxWidth) {
        rows.push([]);
        used = 0;
      }
      rows[rows.length - 1].push({ series, index, label, width });
      used += width;
    });
    return rows;
  }

  function draw(canvas, seriesList, opts = {}) {
    // The hover/tap crosshair below reads this canvas back on every redraw
    // (getImageData for the snapshot, then putImageData to restore it) --
    // willReadFrequently hints the browser to keep the backing store in a
    // format optimized for that instead of re-syncing from the GPU each
    // time. Only matters on the context's first getContext() call for this
    // canvas (later calls just return the same context), which this is.
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(320, canvas.clientWidth || 320);
    const h = Math.max(220, canvas.clientHeight || 220);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = opts.background || "#06171e";
    ctx.fillRect(0, 0, w, h);

    const active = assignAxes(seriesList, opts.unit);
    if (!active.length) {
      ctx.fillStyle = "#94a3b8";
      ctx.font = `12px ${FONT}`;
      ctx.fillText(opts.emptyText || "No data", 18, h / 2);
      canvas._chartState = null;
      bindHoverInteraction(canvas);
      return;
    }

    ctx.font = `10px ${FONT}`;
    const rightSeries = active.filter((series) => series.axis === "right");
    const leftSeries = active.filter((series) => series.axis !== "right");
    const left = axisScale(leftSeries.length ? leftSeries : active);
    const right = rightSeries.length ? axisScale(rightSeries) : null;
    const leftUnit = leftSeries.find((series) => series.unit)?.unit || opts.unit || "";
    const rightUnit = rightSeries.find((series) => series.unit)?.unit || "";
    const padLR = { l: 62, r: right ? 62 : 18 };
    // Wrap the legend against the real plot width (not a guessed constant)
    // so entries can't run into the right-axis tick labels.
    const legendRows = opts.legend === false ? [] : wrappedLegendRows(ctx, active, w - padLR.l - padLR.r);
    const pad = {
      ...padLR,
      t: 18 + legendRows.length * 15,
      b: 46,
    };
    const plotW = Math.max(10, w - pad.l - pad.r);
    const plotH = Math.max(10, h - pad.t - pad.b);

    const timestamps = active.flatMap((series) =>
      series.points.map((point) => Number(point.t)).filter(Number.isFinite)
    );
    let tMin = timestamps.length ? Math.min(...timestamps) : 0;
    let tMax = timestamps.length ? Math.max(...timestamps) : 1;
    if (tMin === tMax) tMax = tMin + 1;
    const tRange = tMax - tMin;
    const xAt = (time) => pad.l + ((time - tMin) / tRange) * plotW;
    const yAt = (value, scale) => pad.t + plotH - ((value - scale.min) / (scale.max - scale.min)) * plotH;

    ctx.lineWidth = 1;
    ctx.font = `9px ${FONT}`;
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 5; i += 1) {
      const ratio = i / 5;
      const y = pad.t + plotH * ratio;
      ctx.strokeStyle = i === 5 ? "#587078" : "rgba(88,112,120,.32)";
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
      const leftValue = left.max - (left.max - left.min) * ratio;
      ctx.fillStyle = "#8aa1a5";
      ctx.textAlign = "right";
      ctx.fillText(numberLabel(leftValue, left.step), pad.l - 7, y);
      if (right) {
        const rightValue = right.max - (right.max - right.min) * ratio;
        ctx.textAlign = "left";
        ctx.fillText(numberLabel(rightValue, right.step), pad.l + plotW + 7, y);
      }
    }

    ctx.textBaseline = "top";
    for (let i = 0; i <= 4; i += 1) {
      const ratio = i / 4;
      const x = pad.l + plotW * ratio;
      ctx.strokeStyle = "rgba(88,112,120,.2)";
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
      ctx.fillStyle = "#8aa1a5";
      ctx.textAlign = i === 0 ? "left" : i === 4 ? "right" : "center";
      ctx.fillText(timeLabel(tMin + tRange * ratio, tRange), x, pad.t + plotH + 7);
    }

    active.forEach((series, index) => {
      const sorted = [...series.points]
        .filter((point) => Number.isFinite(Number(point.v)))
        .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
      if (!sorted.length) return;
      const scale = series.axis === "right" && right ? right : left;
      const color = series.color || COLORS[index % COLORS.length];
      if (sorted.length === 1) {
        // A single-point series has no line to stroke — draw a dot so it's
        // visible instead of silently rendering nothing.
        const x = xAt(Number.isFinite(Number(sorted[0].t)) ? Number(sorted[0].t) : tMin);
        const y = yAt(Number(sorted[0].v), scale);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = series.width || 2;
      ctx.beginPath();
      sorted.forEach((point, pointIndex) => {
        const time = Number.isFinite(Number(point.t))
          ? Number(point.t)
          : tMin + (pointIndex / Math.max(1, sorted.length - 1)) * tRange;
        const x = xAt(time);
        const y = yAt(Number(point.v), scale);
        if (pointIndex === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });

    ctx.font = `600 9px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#a9b9b8";
    ctx.save();
    ctx.translate(13, pad.t + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText(leftUnit ? `VALUE · ${leftUnit}` : "VALUE", 0, 0);
    ctx.restore();
    if (right) {
      ctx.save();
      ctx.translate(w - 11, pad.t + plotH / 2);
      ctx.rotate(Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(rightUnit ? `VALUE · ${rightUnit}` : "VALUE", 0, 0);
      ctx.restore();
    }
    ctx.textAlign = "center";
    ctx.fillText(opts.xLabel || "TIME", pad.l + plotW / 2, h - 9);

    if (legendRows.length) {
      ctx.font = `9px ${FONT}`;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      legendRows.forEach((row, rowIndex) => {
        let x = pad.l;
        const y = 10 + rowIndex * 15;
        row.forEach((item) => {
          const color = item.series.color || COLORS[item.index % COLORS.length];
          ctx.fillStyle = color;
          ctx.fillRect(x, y - 2, 11, 3);
          if (item.series.axis === "right") {
            ctx.strokeStyle = color;
            ctx.strokeRect(x, y - 5, 11, 9);
          }
          ctx.fillStyle = "#b7c4c3";
          ctx.fillText(item.label, x + 16, y);
          x += item.width;
        });
      });
    }

    // Cache everything a hover/tap crosshair needs to redraw without
    // recomputing the whole chart, plus a clean-image snapshot to restore
    // before drawing the overlay on the next pointer event.
    canvas._chartState = { active, pad, plotW, plotH, tMin, tRange, left, right, xAt, yAt, w, h };
    canvas._chartState.snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
    bindHoverInteraction(canvas);
  }

  function nearestHits(state, time) {
    return state.active.map((series, index) => {
      const sorted = [...series.points]
        .filter((point) => Number.isFinite(Number(point.v)) && Number.isFinite(Number(point.t)))
        .sort((a, b) => a.t - b.t);
      if (!sorted.length) return null;
      let nearest = sorted[0];
      let bestDiff = Math.abs(sorted[0].t - time);
      for (const point of sorted) {
        const diff = Math.abs(point.t - time);
        if (diff < bestDiff) { nearest = point; bestDiff = diff; }
      }
      return { series, index, point: nearest };
    }).filter(Boolean);
  }

  function renderCrosshair(canvas, pointerX, pointerY) {
    const state = canvas._chartState;
    if (!state?.snapshot) return;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(state.snapshot, 0, 0);
    const { pad, plotW, plotH, tMin, tRange, xAt, yAt, left, right, w, h } = state;
    const clampedX = Math.max(pad.l, Math.min(pointerX, pad.l + plotW));
    const time = tMin + ((clampedX - pad.l) / plotW) * tRange;
    const hits = nearestHits(state, time);
    if (!hits.length) return;
    const x = xAt(hits[0].point.t);

    ctx.save();
    ctx.strokeStyle = "rgba(216,225,225,.45)";
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    const lines = [new Date(hits[0].point.t).toLocaleString()];
    hits.forEach(({ series, index, point }) => {
      const scale = series.axis === "right" && right ? right : left;
      const y = yAt(Number(point.v), scale);
      const color = series.color || COLORS[index % COLORS.length];
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#06171e";
      ctx.lineWidth = 1;
      ctx.stroke();
      lines.push(`${series.label || `Series ${index + 1}`}: ${numberLabel(Number(point.v), 0.01)}${series.unit ? ` ${series.unit}` : ""}`);
    });

    ctx.font = `10px ${FONT}`;
    const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const boxW = textWidth + 16;
    const boxH = lines.length * 14 + 8;
    let boxX = x + 10;
    if (boxX + boxW > w - 4) boxX = x - boxW - 10;
    let boxY = Math.max(4, (pointerY ?? pad.t) - boxH / 2);
    if (boxY + boxH > h - 4) boxY = h - boxH - 4;
    ctx.fillStyle = "rgba(6,23,30,.94)";
    ctx.strokeStyle = "#304b52";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(boxX, boxY, boxW, boxH, 4);
    else ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
      ctx.fillStyle = i === 0 ? "#8aa1a5" : "#e8edf4";
      ctx.fillText(line, boxX + 8, boxY + 5 + i * 14);
    });
    ctx.restore();
  }

  function clearCrosshair(canvas) {
    const state = canvas._chartState;
    if (!state?.snapshot) return;
    canvas.getContext("2d").putImageData(state.snapshot, 0, 0);
  }

  // Binds pointer interaction once per canvas element (draw() is called
  // repeatedly — on every data refresh/resize — so this guards against
  // stacking duplicate listeners on the same element).
  function bindHoverInteraction(canvas) {
    if (canvas._chartHoverBound) return;
    canvas._chartHoverBound = true;
    canvas.style.touchAction = "none";
    const pointerXY = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    canvas.addEventListener("pointermove", (event) => {
      if (!canvas._chartState) return;
      const { x, y } = pointerXY(event);
      renderCrosshair(canvas, x, y);
    });
    canvas.addEventListener("pointerdown", (event) => {
      if (!canvas._chartState) return;
      const { x, y } = pointerXY(event);
      renderCrosshair(canvas, x, y);
    });
    canvas.addEventListener("pointerleave", () => clearCrosshair(canvas));
    canvas.addEventListener("pointerup", () => clearCrosshair(canvas));
    canvas.addEventListener("pointercancel", () => clearCrosshair(canvas));
  }

  // Open-Meteo returns wall-clock strings with no UTC offset (e.g.
  // "2026-08-02T14:00"), scoped to the requested `timezone` param (the
  // queried point's local zone for "auto", or UTC for "GMT"). Per the ES
  // date-time string spec, parsing that string directly with `new Date()`
  // treats it as the *browser's* local time instead — so a viewer whose
  // timezone differs from the query gets every timestamp shifted. Parsing
  // as UTC first and then subtracting the dataset's utc_offset_seconds
  // recovers the true absolute instant regardless of the viewer's zone.
  function localIsoToUtcMs(isoLocal, offsetSeconds = 0) {
    const s = String(isoLocal ?? "");
    if (!s) return NaN;
    const hasZone = /Z$|[+-]\d\d:?\d\d$/.test(s);
    const hasTime = s.includes("T");
    // Date-only strings ("YYYY-MM-DD") already parse as UTC per spec; only
    // datetime strings need a "Z" forced on to avoid local-time parsing.
    const utcGuess = Date.parse(hasZone || !hasTime ? s : `${s}Z`);
    return Number.isFinite(utcGuess) ? utcGuess - offsetSeconds * 1000 : NaN;
  }

  function hourlySeries(times, values, offsetSeconds = 0) {
    return (times || [])
      .map((time, index) => ({ t: localIsoToUtcMs(time, offsetSeconds), v: values?.[index] }))
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.v));
  }

  return { draw, hourlySeries, dailySeries: hourlySeries, localIsoToUtcMs, assignAxes, COLORS };
})();
