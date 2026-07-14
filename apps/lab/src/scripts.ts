import type { Skin } from "./markup";

/**
 * Inline client scripts for the chaos behaviours. They locate elements via
 * class selectors (skin.jsSel) so they keep working under classDrift, where
 * ids are stripped and only the drifted class names remain.
 */

/** Newsletter modal that appears ~800ms after load and blocks the page. */
export function modalScript(skin: Skin): string {
  const backdrop = skin.cls("modal-backdrop");
  const modal = skin.cls("newsletter-modal");
  const actions = skin.cls("modal-actions");
  const closeCls = skin.cls("modal-close");
  const dismissCls = skin.cls("modal-dismiss");
  const btn = skin.cls("btn");
  const primary = skin.cls("btn-primary");
  const modalId = skin.idAttr("newsletter-modal");
  const closeId = skin.idAttr("modal-close");
  return `<script>(function(){
    setTimeout(function(){
      if (document.querySelector('${skin.jsSel("modal-backdrop")}')) return;
      var b = document.createElement("div");
      b.className = "${backdrop}";
      b.innerHTML = '<div class="${modal}"${modalId}>'
        + '<h2>Never miss a fixture</h2>'
        + '<p>Get the weekly form guide and price moves in your inbox.</p>'
        + '<div class="${actions}">'
        + '<button type="button" class="${closeCls} ${btn}"${closeId} aria-label="Close">Close</button>'
        + '<button type="button" class="${dismissCls} ${btn} ${primary}">No thanks</button>'
        + '</div></div>';
      document.body.appendChild(b);
      function close() { b.remove(); }
      var c = b.querySelector('${skin.jsSel("modal-close")}');
      var d = b.querySelector('${skin.jsSel("modal-dismiss")}');
      if (c) c.addEventListener("click", close);
      if (d) d.addEventListener("click", close);
    }, 800);
  })();</script>`;
}

/** Swap a skeleton for the real table after the seeded delay. */
export function delayedScript(skin: Skin): string {
  return `<script>(function(){
    var sk = document.querySelector('${skin.jsSel("skeleton")}');
    var tpl = document.querySelector('${skin.jsSel("table-template")}');
    if (!sk || !tpl) return;
    var ms = parseInt(sk.getAttribute("data-delay-ms"), 10) || 2000;
    setTimeout(function(){ sk.replaceWith(tpl.content.cloneNode(true)); }, ms);
  })();</script>`;
}

/** Client-side pagination driven by an embedded JSON payload of all rows. */
export function paginationScript(skin: Skin): string {
  const cellAttr = skin.classAttr("cell");
  return `<script>(function(){
    var el = document.querySelector('${skin.jsSel("table-data")}');
    var body = document.querySelector('${skin.jsSel("tbody-rows")}');
    var ind = document.querySelector('${skin.jsSel("page-indicator")}');
    var prev = document.querySelector('${skin.jsSel("prev-page")}');
    var next = document.querySelector('${skin.jsSel("next-page")}');
    if (!el || !body) return;
    var data = JSON.parse(el.textContent || "[]");
    var size = 5, page = 0, pages = Math.max(1, Math.ceil(data.length / size));
    function render() {
      var rows = data.slice(page * size, (page + 1) * size);
      body.innerHTML = rows.map(function(r){
        return "<tr>" + r.map(function(c){ return "<td" + ${JSON.stringify(cellAttr)} + ">" + c + "</td>"; }).join("") + "</tr>";
      }).join("");
      if (ind) ind.textContent = "Page " + (page + 1) + " of " + pages;
      if (prev) prev.disabled = page === 0;
      if (next) next.disabled = page >= pages - 1;
    }
    if (prev) prev.addEventListener("click", function(){ if (page > 0) { page--; render(); } });
    if (next) next.addEventListener("click", function(){ if (page < pages - 1) { page++; render(); } });
    render();
  })();</script>`;
}

/** Two-tab layout where the real table hides behind a non-default tab. */
export function hiddenTabScript(skin: Skin): string {
  const active = skin.cls("tab-active");
  return `<script>(function(){
    var tabOverview = document.querySelector('${skin.jsSel("tab-overview")}');
    var tabTable = document.querySelector('${skin.jsSel("tab-table")}');
    var panelOverview = document.querySelector('${skin.jsSel("panel-overview")}');
    var panelTable = document.querySelector('${skin.jsSel("panel-table")}');
    if (!tabOverview || !tabTable || !panelOverview || !panelTable) return;
    function show(showTable) {
      panelTable.hidden = !showTable;
      panelOverview.hidden = showTable;
      tabTable.classList.toggle("${active}", showTable);
      tabOverview.classList.toggle("${active}", !showTable);
    }
    tabOverview.addEventListener("click", function(){ show(false); });
    tabTable.addEventListener("click", function(){ show(true); });
  })();</script>`;
}
