/* Expand / resize chrome for nc-plot-win windows */
window.GlobePlotExpand = (() => {
  "use strict";

  function attach(wrap, cv, refreshFn, opts = {}) {
    if (!wrap || wrap.dataset.plotChrome) return;
    wrap.dataset.plotChrome = "1";
    const minW = opts.minW ?? 300;
    const minH = opts.minH ?? 200;
    const normalW = opts.normalW ?? (cv.width || 620);
    const normalH = opts.normalH ?? (cv.height || 300);

    const head = wrap.querySelector(".pw-head") || wrap.firstElementChild;
    const btnRow = head?.querySelector("div") || head;
    const expBtn = document.createElement("button");
    expBtn.type = "button";
    expBtn.className = "pw-expand";
    expBtn.title = "Expand / restore";
    expBtn.textContent = "⤢";
    expBtn.style.cssText =
      "background:none;border:1px solid rgba(127,208,255,0.35);color:#cfe3f2;cursor:pointer;" +
      "font-size:11px;font-family:IBM Plex Mono,monospace;padding:1px 7px;border-radius:4px;margin-left:6px;";

    const closeBtn = wrap.querySelector(".pw-x");
    if (closeBtn) closeBtn.before(expBtn);
    else if (btnRow) btnRow.appendChild(expBtn);
    else wrap.insertBefore(expBtn, wrap.firstChild);

    let expanded = false;
    let saved = null;

    expBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!expanded) {
        saved = {
          left: wrap.style.left,
          top: wrap.style.top,
          width: wrap.style.width,
          height: wrap.style.height,
          userW: wrap._userW,
          userH: wrap._userH,
        };
        wrap.style.left = "2vw";
        wrap.style.top = "4vh";
        wrap.style.width = "96vw";
        wrap.style.height = "92vh";
        wrap.style.maxWidth = "none";
        wrap._userW = Math.max(minW, Math.round(window.innerWidth * 0.94));
        wrap._userH = Math.max(minH, Math.round(window.innerHeight * 0.82));
        expanded = true;
        expBtn.textContent = "⤡";
      } else {
        wrap.style.left = saved?.left || "";
        wrap.style.top = saved?.top || "";
        wrap.style.width = saved?.width || "";
        wrap.style.height = saved?.height || "";
        wrap._userW = saved?.userW ?? normalW;
        wrap._userH = saved?.userH ?? normalH;
        expanded = false;
        expBtn.textContent = "⤢";
      }
      if (typeof refreshFn === "function") refreshFn();
    });

    if (!wrap.querySelector(".pw-resize-grip")) {
      const grip = document.createElement("div");
      grip.className = "pw-resize-grip";
      grip.style.cssText =
        "position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:se-resize;" +
        "background:linear-gradient(135deg,transparent 50%,rgba(127,208,255,0.35) 50%);border-radius:0 0 10px 0;";
      wrap.style.position = wrap.style.position || "fixed";
      wrap.appendChild(grip);

      let mx0 = 0;
      let my0 = 0;
      let rw0 = 0;
      let rh0 = 0;
      let resizing = false;
      grip.addEventListener("mousedown", (e) => {
        resizing = true;
        mx0 = e.clientX;
        my0 = e.clientY;
        rw0 = wrap._userW || cv.width || normalW;
        rh0 = wrap._userH || cv.height || normalH;
        e.preventDefault();
        e.stopPropagation();
      });
      document.addEventListener("mousemove", (e) => {
        if (!resizing) return;
        wrap._userW = Math.max(minW, rw0 + (e.clientX - mx0));
        wrap._userH = Math.max(minH, rh0 + (e.clientY - my0));
        if (typeof refreshFn === "function") refreshFn();
      });
      document.addEventListener("mouseup", () => {
        resizing = false;
      });
    }
  }

  return { attach };
})();
