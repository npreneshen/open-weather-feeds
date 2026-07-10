/* Canvas chart helpers — multi-series time series for Global Feeds */
window.GlobalCharts = (() => {
  "use strict";

  const COLORS = ["#38bdf8", "#f472b6", "#4ade80", "#fbbf24", "#a78bfa", "#fb923c"];

  function draw(canvas, seriesList, opts = {}) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 8, r: 8, t: 22, b: 18 };
    const plotW = w - pad.l - pad.r;
    const plotH = h - pad.t - pad.b;

    const active = (seriesList || []).filter((s) => s.points?.length);
    if (!active.length) {
      ctx.fillStyle = "#64748b";
      ctx.font = "12px Segoe UI, system-ui, sans-serif";
      ctx.fillText(opts.emptyText || "No data", pad.l, h / 2);
      return;
    }

    let tMin = Infinity;
    let tMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const s of active) {
      for (const p of s.points) {
        if (p.t != null) { tMin = Math.min(tMin, p.t); tMax = Math.max(tMax, p.t); }
        if (Number.isFinite(p.v)) { vMin = Math.min(vMin, p.v); vMax = Math.max(vMax, p.v); }
      }
    }
    if (!Number.isFinite(tMin)) { tMin = 0; tMax = 1; }
    if (!Number.isFinite(vMin)) { vMin = 0; vMax = 1; }
    const vPad = (vMax - vMin) * 0.08 || 1;
    vMin -= vPad;
    vMax += vPad;
    const tRange = Math.max(1, tMax - tMin);
    const vRange = Math.max(1e-9, vMax - vMin);

    const xAt = (t) => pad.l + ((t - tMin) / tRange) * plotW;
    const yAt = (v) => pad.t + plotH - ((v - vMin) / vRange) * plotH;

    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + plotH);
    ctx.lineTo(pad.l + plotW, pad.t + plotH);
    ctx.stroke();

    active.forEach((s, i) => {
      const sorted = [...s.points].sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
      const color = s.color || COLORS[i % COLORS.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = s.width || 2;
      ctx.beginPath();
      sorted.forEach((p, idx) => {
        const x = p.t != null ? xAt(p.t) : pad.l + (idx / Math.max(1, sorted.length - 1)) * plotW;
        const y = yAt(p.v);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      if (s.fill) {
        ctx.lineTo(xAt(sorted[sorted.length - 1].t ?? tMax), pad.t + plotH);
        ctx.lineTo(xAt(sorted[0].t ?? tMin), pad.t + plotH);
        ctx.closePath();
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
    });

    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px Segoe UI, system-ui, sans-serif";
    const unit = opts.unit || active[0]?.unit || "";
    ctx.fillText(`${vMin.toFixed(1)} – ${vMax.toFixed(1)} ${unit}`.trim(), pad.l, 12);

    if (opts.legend !== false && active.length > 1) {
      let lx = pad.l;
      const ly = h - 4;
      ctx.font = "9px Segoe UI, system-ui, sans-serif";
      for (let i = 0; i < active.length; i++) {
        const s = active[i];
        const color = s.color || COLORS[i % COLORS.length];
        ctx.fillStyle = color;
        ctx.fillRect(lx, ly - 8, 10, 3);
        ctx.fillStyle = "#94a3b8";
        const label = s.label || `Series ${i + 1}`;
        ctx.fillText(label, lx + 13, ly);
        lx += ctx.measureText(label).width + 24;
      }
    }
  }

  function hourlySeries(times, values) {
    return (times || [])
      .map((t, i) => ({ t: new Date(t).getTime(), v: values[i] }))
      .filter((p) => Number.isFinite(p.v));
  }

  function dailySeries(times, values) {
    return hourlySeries(times, values);
  }

  return { draw, hourlySeries, dailySeries, COLORS };
})();
