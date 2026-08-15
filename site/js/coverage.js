/* Rullo Enterprises — coverage explorer
   Searchable list of destinations that funnels into the checkout widget.
   No live operator data (that needs the Reloadly API); this confirms a
   destination is reachable and jumps the visitor to the storefront, where
   the widget shows the exact operators, brands, and providers available. */
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
    var cats = ["Airtime", "Data", "Gift cards", "Bills"]
      .map(function (x) { return "<span>" + x + "</span>"; }).join("");
    panel.innerHTML =
      '<div class="cov-flag" aria-hidden="true">' + flag(c[1]) + "</div>" +
      "<h3>" + c[0] + "</h3>" +
      '<p class="cov-reach mono">✓ Reachable</p>' +
      '<p class="cov-desc">Find the mobile operators, gift card brands, and utility providers available in ' +
        c[0] + " inside the storefront.</p>" +
      '<div class="cov-cats">' + cats + "</div>" +
      '<a href="#storefront" class="btn btn-fill cov-go">Send to ' + c[0] + " &rarr;</a>";
    panel.classList.add("is-selected");
  }

  search.addEventListener("input", function () {
    var q = search.value.trim().toLowerCase();
    render(q ? COUNTRIES.filter(function (c) { return c[0].toLowerCase().indexOf(q) > -1; }) : COUNTRIES);
  });

  render(COUNTRIES);
})();
