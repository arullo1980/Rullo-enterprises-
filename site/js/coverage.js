/* Rullo Enterprises — coverage explorer
   Searchable list of destinations that funnels into the checkout widget.

   Two modes, decided at runtime by window.RULLO_CONFIG.apiBase (js/config.js):

   offline (default)  no proxy configured — confirms the destination is
                      reachable and jumps the visitor to the storefront, where
                      the widget shows the exact operators and brands.
   live               proxy configured — additionally fetches the real
                      operators, gift card brands, and billers for the country.

   Live mode is strictly additive. If the proxy is unset, slow, or down, the
   panel keeps the offline content and the visitor sees nothing broken. */
(function () {
  var COUNTRIES = [
    ["Afghanistan","AF"],["Algeria","DZ"],["Angola","AO"],["Argentina","AR"],["Australia","AU"],
    ["Austria","AT"],["Bahrain","BH"],["Bangladesh","BD"],["Belgium","BE"],["Benin","BJ"],
    ["Bolivia","BO"],["Botswana","BW"],["Brazil","BR"],["Bulgaria","BG"],["Burkina Faso","BF"],
    ["Cambodia","KH"],["Cameroon","CM"],["Canada","CA"],["Chile","CL"],["China","CN"],
    ["Colombia","CO"],["Costa Rica","CR"],["Croatia","HR"],["Cuba","CU"],["Czechia","CZ"],
    ["Denmark","DK"],["Dominican Republic","DO"],["DR Congo","CD"],["Ecuador","EC"],["Egypt","EG"],
    ["El Salvador","SV"],["Ethiopia","ET"],["Fiji","FJ"],["Finland","FI"],["France","FR"],
    ["Gabon","GA"],["Germany","DE"],["Ghana","GH"],["Greece","GR"],["Guatemala","GT"],
    ["Haiti","HT"],["Honduras","HN"],["Hong Kong","HK"],["Hungary","HU"],["India","IN"],
    ["Indonesia","ID"],["Iraq","IQ"],["Ireland","IE"],["Israel","IL"],["Italy","IT"],
    ["Ivory Coast","CI"],["Jamaica","JM"],["Japan","JP"],["Jordan","JO"],["Kenya","KE"],
    ["Kuwait","KW"],["Laos","LA"],["Lebanon","LB"],["Liberia","LR"],["Malawi","MW"],
    ["Malaysia","MY"],["Mali","ML"],["Mexico","MX"],["Morocco","MA"],["Mozambique","MZ"],
    ["Myanmar","MM"],["Namibia","NA"],["Nepal","NP"],["Netherlands","NL"],["New Zealand","NZ"],
    ["Nicaragua","NI"],["Nigeria","NG"],["Norway","NO"],["Oman","OM"],["Pakistan","PK"],
    ["Panama","PA"],["Papua New Guinea","PG"],["Paraguay","PY"],["Peru","PE"],["Philippines","PH"],
    ["Poland","PL"],["Portugal","PT"],["Qatar","QA"],["Romania","RO"],["Rwanda","RW"],
    ["Saudi Arabia","SA"],["Senegal","SN"],["Serbia","RS"],["Sierra Leone","SL"],["Singapore","SG"],
    ["South Africa","ZA"],["South Korea","KR"],["Spain","ES"],["Sri Lanka","LK"],["Sweden","SE"],
    ["Switzerland","CH"],["Taiwan","TW"],["Tanzania","TZ"],["Thailand","TH"],["Togo","TG"],
    ["Trinidad & Tobago","TT"],["Tunisia","TN"],["Turkey","TR"],["Uganda","UG"],["Ukraine","UA"],
    ["United Arab Emirates","AE"],["United Kingdom","GB"],["United States","US"],["Uruguay","UY"],
    ["Venezuela","VE"],["Vietnam","VN"],["Yemen","YE"],["Zambia","ZM"],["Zimbabwe","ZW"]
  ];

  /* Coverage category key -> the label the storefront already uses. */
  var CATEGORIES = [
    ["operators", "Airtime"],
    ["data", "Data"],
    ["giftcards", "Gift cards"],
    ["utilities", "Bills"]
  ];

  var API_BASE = (function () {
    var cfg = window.RULLO_CONFIG || {};
    return (cfg.apiBase || "").replace(/\/+$/, "");
  })();

  var LIVE_TIMEOUT_MS = 6000;
  var cache = {};        // iso -> coverage payload
  var requestSeq = 0;    // guards against a slow response overwriting a newer pick

  function flag(iso) {
    return iso.toUpperCase().replace(/./g, function (c) {
      return String.fromCodePoint(127397 + c.charCodeAt(0));
    });
  }

  var grid = document.getElementById("covGrid");
  var panel = document.getElementById("covPanel");
  var search = document.getElementById("covSearch");
  var count = document.getElementById("covCount");
  if (!grid || !panel || !search) return;

  COUNTRIES.sort(function (a, b) { return a[0].localeCompare(b[0]); });

  function render(list) {
    grid.innerHTML = "";
    if (!list.length) {
      grid.innerHTML = '<p class="cov-empty">No match — it may still be reachable. Try the storefront search below.</p>';
      count.textContent = "0 destinations";
      return;
    }
    var frag = document.createDocumentFragment();
    list.forEach(function (c) {
      var b = document.createElement("button");
      b.className = "cov-chip";
      b.type = "button";
      b.setAttribute("role", "option");
      b.innerHTML = '<span class="cf" aria-hidden="true">' + flag(c[1]) + "</span><span>" + c[0] + "</span>";
      b.addEventListener("click", function () { select(c); });
      frag.appendChild(b);
    });
    grid.appendChild(frag);
    count.textContent = list.length + " destinations";
  }

  function select(c) {
    var cats = CATEGORIES
      .map(function (x) { return "<span>" + x[1] + "</span>"; }).join("");
    panel.innerHTML =
      '<div class="cov-flag" aria-hidden="true">' + flag(c[1]) + "</div>" +
      "<h3>" + c[0] + "</h3>" +
      '<p class="cov-reach mono">✓ Reachable</p>' +
      '<p class="cov-desc">Find the mobile operators, gift card brands, and utility providers available in ' +
        c[0] + " inside the storefront.</p>" +
      '<div class="cov-cats">' + cats + "</div>" +
      '<div class="cov-live" hidden></div>' +
      '<a href="#storefront" class="btn btn-fill cov-go">Send to ' + c[0] + " &rarr;</a>";
    panel.classList.add("is-selected");

    if (API_BASE) loadLive(c);
  }

  /* --- Live coverage (only runs when a proxy URL is configured) --- */

  function loadLive(c) {
    var iso = c[1];
    var seq = ++requestSeq;

    if (cache[iso]) { applyLive(cache[iso], seq); return; }

    var live = panel.querySelector(".cov-live");
    if (live) {
      live.hidden = false;
      live.className = "cov-live is-loading";
      live.textContent = "Checking live coverage…";
    }

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, LIVE_TIMEOUT_MS);

    fetch(API_BASE + "/coverage?country=" + encodeURIComponent(iso), { signal: ctrl.signal })
      .then(function (res) {
        if (!res.ok) throw new Error("coverage " + res.status);
        return res.json();
      })
      .then(function (data) {
        cache[iso] = data;
        applyLive(data, seq);
      })
      .catch(function () {
        // The offline content is already on screen and stays as the fallback —
        // just drop the live strip so nothing looks half-loaded.
        if (seq === requestSeq) hideLive();
      })
      .then(function () { clearTimeout(timer); });
  }

  function hideLive() {
    var live = panel.querySelector(".cov-live");
    if (live) { live.hidden = true; live.textContent = ""; }
  }

  function applyLive(data, seq) {
    if (seq !== requestSeq) return;          // a newer country was picked
    var cats = data && data.categories;
    if (!cats) { hideLive(); return; }

    // Real counts on the category chips, so "Bills" never promises a service
    // the country has none of.
    var chips = panel.querySelectorAll(".cov-cats span");
    CATEGORIES.forEach(function (pair, i) {
      var chip = chips[i];
      var info = cats[pair[0]];
      if (!chip) return;
      if (!info || !info.available) { chip.classList.add("is-unknown"); return; }
      chip.classList.toggle("is-none", info.count === 0);
      if (info.count > 0) chip.textContent = pair[1] + " · " + info.count;
    });

    var names = (cats.operators && cats.operators.sample) || [];
    var live = panel.querySelector(".cov-live");
    if (!live) return;

    if (!names.length) { hideLive(); return; }

    live.className = "cov-live";
    live.hidden = false;
    live.textContent = "";

    var label = document.createElement("p");
    label.className = "cov-live-label mono";
    label.textContent = "Operators available";
    live.appendChild(label);

    var ul = document.createElement("ul");
    ul.className = "cov-live-list";
    names.forEach(function (name) {
      var li = document.createElement("li");
      li.textContent = name;                 // API data — text only, never HTML
      ul.appendChild(li);
    });
    live.appendChild(ul);
  }

  search.addEventListener("input", function () {
    var q = search.value.trim().toLowerCase();
    render(q ? COUNTRIES.filter(function (c) { return c[0].toLowerCase().indexOf(q) > -1; }) : COUNTRIES);
  });

  render(COUNTRIES);
})();
