(function () {
  "use strict";

  var ALIGNMENTS = KEE_ALIGNMENT_DATA.alignments;
  var Geo = window.KEEGeo;

  var WEAK_GPS_THRESHOLD_M = 30;
  var MANUAL_BRIDGE_RELEASE_M = 38;
  var LOCAL_TILE_URL = "./tiles/{z}/{y}/{x}.jpg";
  var TRANSPARENT_TILE =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  var INTERCHANGE_VIEWS = {
    busega: { label: "Busega", lat: 0.3095, lon: 32.5138, zoom: 17 },
    kajjansi: { label: "Kajjansi", lat: 0.2145, lon: 32.5322, zoom: 17 },
    lweza: { label: "Lweza", lat: 0.2108, lon: 32.5425, zoom: 17 },
    mpala: { label: "Mpala / AA", lat: 0.1058, lon: 32.5112, zoom: 17 }
  };

  var state = {
    manualBridgeLockId: null,
    activeAlignmentId: "mainline",
    followGps: true,
    lastFix: null,
    lastResolved: null,
    lastStatusCode: null,
    simActive: false,
    simTimer: null,
    simAlignmentId: "mainline",
    simCh: 11720,
    simOffset: 0,
    copyTimer: null
  };

  var el = {
    simBanner: document.getElementById("simBanner"),
    exitSimBtn: document.getElementById("exitSimBtn"),
    hudCard: document.getElementById("hudCard"),
    codeTag: document.getElementById("codeTag"),
    alignmentLabel: document.getElementById("alignmentLabel"),
    gpsPill: document.getElementById("gpsPill"),
    gpsStatusText: document.getElementById("gpsStatusText"),
    setupBtn: document.getElementById("setupBtn"),
    chainageReadout: document.getElementById("chainageReadout"),
    sidePill: document.getElementById("sidePill"),
    copyToast: document.getElementById("copyToast"),
    rampDesc: document.getElementById("rampDesc"),
    altRow: document.getElementById("altRow"),
    weakGpsStrip: document.getElementById("weakGpsStrip"),
    offAlignStrip: document.getElementById("offAlignStrip"),
    retryGpsBtn: document.getElementById("retryGpsBtn"),
    followBtn: document.getElementById("followBtn"),
    setupSheet: document.getElementById("setupSheet"),
    closeSetupBtn: document.getElementById("closeSetupBtn"),
    jumpBtns: Array.prototype.slice.call(document.querySelectorAll("[data-jump]")),
    fitBtn: document.getElementById("fitBtn"),
    toggleSimBtn: document.getElementById("toggleSimBtn"),
    simDrawer: document.getElementById("simDrawer"),
    simLabel: document.getElementById("simLabel"),
    simRouteSelect: document.getElementById("simRouteSelect"),
    simChSlider: document.getElementById("simChSlider"),
    simOffSlider: document.getElementById("simOffSlider"),
    simDriveBtn: document.getElementById("simDriveBtn"),
    simOffRoadBtn: document.getElementById("simOffRoadBtn"),
    simCloseBtn: document.getElementById("simCloseBtn")
  };

  function getAlignment(id) {
    for (var i = 0; i < ALIGNMENTS.length; i++) {
      if (ALIGNMENTS[i].id === id) return ALIGNMENTS[i];
    }
    return ALIGNMENTS[0];
  }

  // --- Satellite-Only Dual-Layer Local Tile Map (100% Pre-Bundled Inside APK) ---
  var map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
    fadeAnimation: false,
    maxZoom: 19,
    minZoom: 12
  });

  // Base z12-16 pre-bundled satellite tiles (scales smoothly up to z19 underneath)
  L.tileLayer(LOCAL_TILE_URL, {
    minZoom: 12,
    maxZoom: 19,
    maxNativeZoom: 16,
    keepBuffer: 4,
    zIndex: 1,
    errorTileUrl: TRANSPARENT_TILE,
    attribution: "Offline Satellite"
  }).addTo(map);

  // High-detail z17 pre-bundled satellite tiles on top
  L.tileLayer(LOCAL_TILE_URL, {
    minZoom: 17,
    maxZoom: 19,
    maxNativeZoom: 17,
    keepBuffer: 3,
    zIndex: 2,
    errorTileUrl: TRANSPARENT_TILE
  }).addTo(map);

  map.on("dragstart", function () {
    if (state.followGps) {
      state.followGps = false;
      el.followBtn.classList.remove("active");
    }
  });

  // --- Draw All 32 Color-Coded As-Built Alignments ---
  var allLatLngs = [];
  var spines = [];
  var ramps = [];
  for (var i = 0; i < ALIGNMENTS.length; i++) {
    if (ALIGNMENTS[i].kind === "spine") spines.push(ALIGNMENTS[i]);
    else ramps.push(ALIGNMENTS[i]);
  }
  var drawOrder = spines.concat(ramps);

  for (var d = 0; d < drawOrder.length; d++) {
    var align = drawOrder[d];
    var latlngs = [];
    for (var p = 0; p < align.points.length; p++) {
      var ll = [align.points[p][1], align.points[p][2]];
      latlngs.push(ll);
      allLatLngs.push(ll);
    }
    var isSpine = align.kind === "spine";

    if (!isSpine) {
      L.polyline(latlngs, {
        color: align.color,
        weight: 10,
        opacity: 0.24,
        lineCap: "round",
        interactive: false
      }).addTo(map);
    }

    L.polyline(latlngs, {
      color: "#0B1220",
      weight: isSpine ? 7.5 : 5.5,
      opacity: 0.88,
      lineCap: "round",
      interactive: false
    }).addTo(map);

    L.polyline(latlngs, {
      color: align.color,
      weight: isSpine ? 3.8 : 3.0,
      opacity: 0.98,
      lineCap: "round",
      interactive: false
    }).addTo(map);
  }

  var corridorBounds = L.latLngBounds(allLatLngs);
  map.fitBounds(corridorBounds, { paddingTopLeft: [20, 140], paddingBottomRight: [20, 60] });

  // --- Zoom-Aware 50 m Station Markers & Color-Coded Ramp Badges (With Pixel Collision Guard) ---
  var labelsLayer = L.layerGroup().addTo(map);

  function refreshStationLabels() {
    labelsLayer.clearLayers();
    var z = map.getZoom();
    var viewBounds = map.getBounds().pad(0.12);
    var placedBoxes = [];

    function tryPlace(lat, lon, halfW, halfH, html, zOffset) {
      var pt = map.latLngToContainerPoint([lat, lon]);
      for (var k = 0; k < placedBoxes.length; k++) {
        var b = placedBoxes[k];
        if (Math.abs(pt.x - b.x) < halfW + b.w && Math.abs(pt.y - b.y) < halfH + b.h) {
          return false;
        }
      }
      placedBoxes.push({ x: pt.x, y: pt.y, w: halfW, h: halfH });
      var icon = L.divIcon({ className: "", html: html, iconSize: [0, 0] });
      L.marker([lat, lon], { icon: icon, interactive: false, zIndexOffset: zOffset || 0 }).addTo(labelsLayer);
      return true;
    }

    // 1) Overview interchange badges when zoomed out (z <= 14)
    if (z <= 14) {
      var keys = Object.keys(INTERCHANGE_VIEWS);
      for (var ki = 0; ki < keys.length; ki++) {
        var info = INTERCHANGE_VIEWS[keys[ki]];
        tryPlace(
          info.lat,
          info.lon,
          34,
          11,
          '<div class="interchange-badge">' + info.label + "</div>",
          220
        );
      }
    }

    // 2) Ramp midpoint code badges first at z >= 15
    if (z >= 15) {
      for (var r = 0; r < ALIGNMENTS.length; r++) {
        var ra = ALIGNMENTS[r];
        if (ra.kind === "spine") continue;
        if (
          ra.bbox.maxLat < viewBounds.getSouth() ||
          ra.bbox.minLat > viewBounds.getNorth() ||
          ra.bbox.maxLon < viewBounds.getWest() ||
          ra.bbox.minLon > viewBounds.getEast()
        ) {
          continue;
        }
        var midPt = ra.points[Math.floor(ra.points.length / 2)];
        if (viewBounds.contains([midPt[1], midPt[2]])) {
          var badgeTxt = ra.code === "ACCESS" ? "ACCESS" : ra.code;
          tryPlace(
            midPt[1],
            midPt[2],
            18,
            11,
            '<div class="ramp-code-badge" style="background:' + ra.pillBg + '">' + badgeTxt + "</div>",
            260
          );
        }
        if (z >= 16) {
          var stPt = ra.points[0];
          if (viewBounds.contains([stPt[1], stPt[2]])) {
            var dotIcon = L.divIcon({
              className: "",
              html: '<div class="ramp-start-dot"></div>',
              iconSize: [10, 10],
              iconAnchor: [5, 5]
            });
            L.marker([stPt[1], stPt[2]], { icon: dotIcon, interactive: false, zIndexOffset: 150 }).addTo(labelsLayer);
          }
        }
      }
    }

    // 3) Spines: 5km (z<=13), 1km (z=14), 200m (z=15), 50m (z>=16)
    var spineStep = z >= 16 ? 50 : z === 15 ? 200 : z === 14 ? 1000 : 5000;
    // 4) Ramps: 100m (z=16), 50m (z>=17)
    var rampStep = z >= 17 ? 50 : z === 16 ? 100 : null;

    for (var ai = 0; ai < ALIGNMENTS.length; ai++) {
      var al = ALIGNMENTS[ai];
      var isSp = al.kind === "spine";
      var isRhs = al.id === "mainline_rhs";

      if (
        z >= 14 &&
        (al.bbox.maxLat < viewBounds.getSouth() ||
          al.bbox.minLat > viewBounds.getNorth() ||
          al.bbox.maxLon < viewBounds.getWest() ||
          al.bbox.minLon > viewBounds.getEast())
      ) {
        continue;
      }
      if (isRhs && z < 16) continue;

      if (isSp) {
        if (al.id === "lk_spur" && z <= 13) continue;
        for (var pi = 0; pi < al.points.length; pi++) {
          var ch = al.points[pi][0];
          var lat = al.points[pi][1];
          var lon = al.points[pi][2];
          var isEnd = pi === 0 || pi === al.points.length - 1;
          var onStep = Math.abs(ch % spineStep) < 0.1;
          if (!isEnd && !onStep) continue;
          if (z >= 14 && !viewBounds.contains([lat, lon])) continue;
          if (isRhs && isEnd) continue;

          var isMaj = Math.abs(ch % 1000) < 0.1 || isEnd;
          var txt =
            Math.abs(ch % 1000) < 0.1 && z <= 14
              ? al.prefix + Math.round(ch / 1000)
              : Geo.formatChainage(ch, al.prefix);

          tryPlace(
            lat,
            lon,
            25,
            9,
            '<div class="ch-tick-label' + (isMaj ? "" : " minor") + '" style="border-color:' + al.color + '">' + txt + "</div>",
            isMaj ? 180 : 120
          );
        }
      } else if (rampStep) {
        for (var ri = 0; ri < al.points.length; ri++) {
          var rch = al.points[ri][0];
          var rlat = al.points[ri][1];
          var rlon = al.points[ri][2];
          if (Math.abs(rch % rampStep) >= 0.1) continue;
          if (rch === 0 && z < 17) continue;
          if (!viewBounds.contains([rlat, rlon])) continue;

          var rlbl =
            al.code === "ACCESS"
              ? "ACC+" + ("000" + Math.round(rch)).slice(-3)
              : Geo.formatChainage(rch, al.prefix);

          tryPlace(
            rlat,
            rlon,
            26,
            9,
            '<div class="ch-tick-label minor" style="border-color:' + al.color + '">' + rlbl + "</div>",
            100
          );
        }
      }
    }
  }

  map.on("zoomend moveend", refreshStationLabels);
  refreshStationLabels();

  // --- Map Markers ---
  var gpsMarker = null;
  var gpsAccCircle = null;
  var tapMarker = null;

  function updateGpsMapMarker(lat, lon, accuracyM) {
    var icon = L.divIcon({
      className: "",
      html: '<div class="gps-live-marker"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    if (!gpsMarker) {
      gpsMarker = L.marker([lat, lon], { icon: icon, zIndexOffset: 900 }).addTo(map);
    } else {
      gpsMarker.setLatLng([lat, lon]);
      gpsMarker.setIcon(icon);
    }

    var accRadius = isFinite(accuracyM) ? Math.max(4, Math.min(accuracyM, 400)) : 10;
    if (!gpsAccCircle) {
      gpsAccCircle = L.circle([lat, lon], {
        radius: accRadius,
        color: "#3B82F6",
        fillColor: "#3B82F6",
        fillOpacity: 0.14,
        weight: 1.5,
        interactive: false
      }).addTo(map);
    } else {
      gpsAccCircle.setLatLng([lat, lon]);
      gpsAccCircle.setRadius(accRadius);
    }

    if (state.followGps) {
      map.setView([lat, lon], Math.max(map.getZoom(), 17), { animate: false });
    }
  }

  // --- Tap Anywhere on Satellite Map to Inspect Exact Code & Chainage ---
  map.on("click", function (ev) {
    var lat = ev.latlng.lat;
    var lng = ev.latlng.lng;
    var res = Geo.resolvePosition(lat, lng, ALIGNMENTS, { lockMode: "auto" });

    var headerTitle =
      res.kind === "ramp"
        ? '<span class="popup-badge" style="background:' + res.pillBg + '">' + res.code + "</span> <span>" + res.groupShort + "</span>"
        : "<span>" + res.groupShort + "</span>";

    var extraDist =
      state.lastResolved && state.lastResolved.alignmentId === res.alignmentId
        ? '<div class="popup-line">Distance from you: <b>' + Geo.formatDistance(res.chainage - state.lastResolved.chainage) + "</b></div>"
        : "";

    var html =
      '<div class="popup-head">' + headerTitle + "</div>" +
      '<div class="popup-ch" style="color:' + res.color + '">' + res.formattedChainage + "</div>" +
      (res.plainBound ? '<div class="popup-line"><b>' + res.plainBound + "</b></div>" : "") +
      (res.kind === "ramp" && res.desc ? '<div class="popup-line">' + res.desc + "</div>" : "") +
      (res.offAlignment ? '<div class="popup-line">' + Geo.formatDistance(res.distanceM) + " from road</div>" : "") +
      extraDist;

    var tapIcon = L.divIcon({
      className: "",
      html: '<div class="tap-pin-marker" style="background:' + res.color + '"></div>',
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });
    if (!tapMarker) {
      tapMarker = L.marker([lat, lng], { icon: tapIcon }).addTo(map);
    } else {
      tapMarker.setLatLng([lat, lng]);
      tapMarker.setIcon(tapIcon);
    }
    tapMarker.bindPopup(html, { closeButton: true, offset: [0, -6] }).openPopup();
  });

  // --- Plain-Language HUD Rendering ---
  function renderChainageMarkup(formatted, prefixColor) {
    var m = formatted.match(/^([A-Z]+)(\d+)\+(\d{3})$/);
    if (!m) return formatted;
    return '<span class="ch-k" style="color:' + prefixColor + '">' + m[1] + "</span>" + m[2] + '<span class="ch-plus">+</span>' + m[3];
  }

  function handlePositionUpdate(lat, lon, accuracyM) {
    if (state.manualBridgeLockId) {
      var lockedAlign = getAlignment(state.manualBridgeLockId);
      var chk = Geo.projectOntoAlignment(lat, lon, lockedAlign);
      if (!chk || chk.distanceM > MANUAL_BRIDGE_RELEASE_M) {
        state.manualBridgeLockId = null;
      }
    }

    var resolved = Geo.resolvePosition(lat, lon, ALIGNMENTS, {
      lockMode: state.manualBridgeLockId || "auto",
      previousAlignmentId: state.activeAlignmentId
    });
    state.activeAlignmentId = resolved.alignmentId;
    state.lastFix = { lat: lat, lon: lon, accuracyM: accuracyM };
    state.lastResolved = resolved;

    el.retryGpsBtn.classList.add("hidden");

    el.gpsPill.classList.remove("good", "fair", "poor");
    var isWeakGps = !state.simActive && isFinite(accuracyM) && accuracyM > WEAK_GPS_THRESHOLD_M;
    if (state.simActive) {
      el.gpsPill.classList.add("good");
      el.gpsStatusText.textContent = "Test Mode";
    } else if (isFinite(accuracyM)) {
      if (accuracyM <= 12) {
        el.gpsPill.classList.add("good");
        el.gpsStatusText.textContent = "GPS Good";
      } else if (accuracyM <= WEAK_GPS_THRESHOLD_M) {
        el.gpsPill.classList.add("fair");
        el.gpsStatusText.textContent = "GPS Fair";
      } else {
        el.gpsPill.classList.add("poor");
        el.gpsStatusText.textContent = "Weak GPS";
      }
    }

    if (isWeakGps) {
      el.hudCard.classList.add("is-weak");
      el.weakGpsStrip.classList.remove("hidden");
      el.weakGpsStrip.textContent = "Weak GPS — step into open sky before reading chainage.";
    } else {
      el.hudCard.classList.remove("is-weak");
      el.weakGpsStrip.classList.add("hidden");
    }

    if (resolved.offAlignment) {
      el.offAlignStrip.classList.remove("hidden");
      el.offAlignStrip.textContent = Geo.formatDistance(resolved.distanceM) + " from road • Nearest " + resolved.formattedChainage;
    } else {
      el.offAlignStrip.classList.add("hidden");
    }

    if (resolved.kind === "ramp") {
      el.codeTag.classList.remove("hidden");
      el.codeTag.textContent = resolved.code;
      el.codeTag.style.background = resolved.pillBg;
      el.alignmentLabel.textContent = resolved.group;
      el.alignmentLabel.style.color = resolved.color;
    } else if (resolved.alignmentId === "lk_spur") {
      el.codeTag.classList.remove("hidden");
      el.codeTag.textContent = "LK";
      el.codeTag.style.background = resolved.pillBg;
      el.alignmentLabel.textContent = "Kajjansi–Lweza Spur";
      el.alignmentLabel.style.color = resolved.color;
    } else {
      el.codeTag.classList.add("hidden");
      el.alignmentLabel.textContent = "Kampala–Entebbe Expressway";
      el.alignmentLabel.style.color = "#CBD5E1";
    }

    el.chainageReadout.innerHTML = renderChainageMarkup(resolved.formattedChainage, resolved.color);

    if (resolved.plainBound) {
      el.sidePill.className = "side-pill";
      if (resolved.sideCode === "LHS") el.sidePill.classList.add("lhs");
      else if (resolved.sideCode === "RHS") el.sidePill.classList.add("rhs");
      else el.sidePill.classList.add("median");
      el.sidePill.textContent = resolved.plainBound;
    } else {
      el.sidePill.className = "side-pill hidden";
    }

    if (resolved.kind === "ramp" && !resolved.offAlignment && resolved.desc) {
      el.rampDesc.classList.remove("hidden");
      el.rampDesc.textContent = resolved.desc;
    } else {
      el.rampDesc.classList.add("hidden");
    }

    if (resolved.nearbyAlternatives && resolved.nearbyAlternatives.length > 0) {
      var chips = "<span>Bridge / crossing:</span>";
      for (var a = 0; a < resolved.nearbyAlternatives.length; a++) {
        var alt = resolved.nearbyAlternatives[a];
        chips +=
          '<button type="button" class="alt-chip" data-switch-id="' +
          alt.alignmentId +
          '" style="border-color:' +
          alt.color +
          '">' +
          alt.formattedChainage +
          "</button>";
      }
      el.altRow.classList.remove("hidden");
      el.altRow.innerHTML = chips;
    } else {
      el.altRow.classList.add("hidden");
      el.altRow.innerHTML = "";
    }

    updateGpsMapMarker(lat, lon, accuracyM);
  }

  // --- Tap Giant Chainage to Copy Clean Text for WhatsApp ---
  el.chainageReadout.addEventListener("click", function () {
    if (!state.lastResolved) return;
    var r = state.lastResolved;
    var copyStr =
      r.kind === "ramp"
        ? r.groupShort + " • " + r.formattedChainage + (r.desc ? " (" + r.desc + ")" : "")
        : r.formattedChainage + (r.plainBound ? " (" + r.plainBound + ")" : "");
    if (window.AndroidBridge && window.AndroidBridge.copyText) {
      window.AndroidBridge.copyText(copyStr);
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(copyStr).catch(function () {});
    }
    el.copyToast.textContent = "Copied: " + copyStr;
    el.copyToast.classList.remove("hidden");
    if (state.copyTimer) clearTimeout(state.copyTimer);
    state.copyTimer = setTimeout(function () {
      el.copyToast.classList.add("hidden");
    }, 1800);
  });

  // --- Native Android GPS Bridge Hooks ---
  window.onNativeGps = function (lat, lon, accuracyM) {
    if (state.simActive) return;
    handlePositionUpdate(lat, lon, accuracyM);
  };

  window.onNativeGpsStatus = function (code, message) {
    if (state.simActive) return;
    state.lastStatusCode = code;
    el.gpsPill.classList.remove("good", "fair", "poor");
    if (code === "searching") {
      el.gpsStatusText.textContent = "Finding GPS…";
      el.retryGpsBtn.classList.add("hidden");
    } else if (code === "gps_off") {
      el.gpsPill.classList.add("poor");
      el.gpsStatusText.textContent = "GPS Off";
      el.weakGpsStrip.classList.remove("hidden");
      el.weakGpsStrip.textContent = message || "Phone GPS is OFF. Turn Location ON.";
      el.retryGpsBtn.textContent = "Turn On Phone GPS";
      el.retryGpsBtn.classList.remove("hidden");
    } else {
      el.gpsPill.classList.add("poor");
      el.gpsStatusText.textContent = "GPS Blocked";
      el.weakGpsStrip.classList.remove("hidden");
      el.weakGpsStrip.textContent = message || "Allow Location permission to track chainage.";
      el.retryGpsBtn.textContent = "Allow GPS Permission";
      el.retryGpsBtn.classList.remove("hidden");
    }
  };

  // Fallback browser geolocation only if previewed outside Android APK
  if (!window.AndroidBridge && navigator.geolocation) {
    navigator.geolocation.watchPosition(
      function (pos) {
        if (!state.simActive) {
          handlePositionUpdate(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
        }
      },
      function () {},
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
    );
  }

  // --- UI Event Wiring ---
  el.altRow.addEventListener("click", function (e) {
    var target = e.target;
    while (target && target !== el.altRow && !target.getAttribute("data-switch-id")) {
      target = target.parentNode;
    }
    if (!target || !target.getAttribute("data-switch-id") || !state.lastFix) return;
    state.manualBridgeLockId = target.getAttribute("data-switch-id");
    handlePositionUpdate(state.lastFix.lat, state.lastFix.lon, state.lastFix.accuracyM);
  });

  el.retryGpsBtn.addEventListener("click", function () {
    if (window.AndroidBridge) {
      if (state.lastStatusCode === "gps_off") {
        window.AndroidBridge.openLocationSettings();
      } else {
        window.AndroidBridge.requestGpsPermission();
      }
    }
  });

  el.followBtn.addEventListener("click", function () {
    state.followGps = true;
    el.followBtn.classList.add("active");
    if (state.lastFix) {
      map.setView([state.lastFix.lat, state.lastFix.lon], Math.max(map.getZoom(), 17), { animate: false });
    } else if (window.AndroidBridge) {
      window.AndroidBridge.requestGpsPermission();
    }
  });

  el.setupBtn.addEventListener("click", function () {
    el.simDrawer.classList.add("hidden");
    el.setupSheet.classList.toggle("hidden");
  });
  el.closeSetupBtn.addEventListener("click", function () {
    el.setupSheet.classList.add("hidden");
  });

  for (var ji = 0; ji < el.jumpBtns.length; ji++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var target = INTERCHANGE_VIEWS[btn.getAttribute("data-jump")];
        if (!target) return;
        state.followGps = false;
        el.followBtn.classList.remove("active");
        el.setupSheet.classList.add("hidden");
        map.setView([target.lat, target.lon], target.zoom, { animate: false });
      });
    })(el.jumpBtns[ji]);
  }

  el.fitBtn.addEventListener("click", function () {
    state.followGps = false;
    el.followBtn.classList.remove("active");
    el.setupSheet.classList.add("hidden");
    map.fitBounds(corridorBounds, { paddingTopLeft: [20, 140], paddingBottomRight: [20, 60] });
  });

  // --- Desk Test Simulator (tucked inside ⚙) ---
  for (var si = 0; si < ALIGNMENTS.length; si++) {
    var a = ALIGNMENTS[si];
    var opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.name + " (" + Geo.formatChainage(a.minCh, a.prefix) + "–" + Geo.formatChainage(a.maxCh, a.prefix) + ")";
    el.simRouteSelect.appendChild(opt);
  }

  function emitSim() {
    var align = getAlignment(state.simAlignmentId);
    var pt = Geo.pointAtChainageOffset(align, state.simCh, state.simOffset);
    el.simLabel.textContent = Geo.formatChainage(state.simCh, align.prefix) + " • " + state.simOffset + " m";
    handlePositionUpdate(pt.lat, pt.lon, 4);
  }

  function stopSimDrive() {
    if (state.simTimer) {
      clearInterval(state.simTimer);
      state.simTimer = null;
      el.simDriveBtn.textContent = "Drive";
    }
  }

  function enterSim() {
    state.simActive = true;
    state.followGps = true;
    state.manualBridgeLockId = null;
    el.followBtn.classList.add("active");
    el.setupSheet.classList.add("hidden");
    el.simBanner.classList.remove("hidden");
    el.simDrawer.classList.remove("hidden");
    emitSim();
  }

  function exitSim() {
    state.simActive = false;
    stopSimDrive();
    el.simBanner.classList.add("hidden");
    el.simDrawer.classList.add("hidden");
    if (window.AndroidBridge) window.AndroidBridge.requestGpsPermission();
  }

  el.toggleSimBtn.addEventListener("click", function () {
    if (state.simActive) exitSim();
    else enterSim();
  });
  el.exitSimBtn.addEventListener("click", exitSim);
  el.simCloseBtn.addEventListener("click", exitSim);

  el.simRouteSelect.addEventListener("change", function () {
    stopSimDrive();
    state.simAlignmentId = el.simRouteSelect.value;
    state.manualBridgeLockId = state.simAlignmentId;
    var align = getAlignment(state.simAlignmentId);
    el.simChSlider.min = String(Math.floor(align.minCh));
    el.simChSlider.max = String(Math.ceil(align.maxCh));
    state.simCh = Math.round((align.minCh + align.maxCh) / 2);
    el.simChSlider.value = String(state.simCh);
    emitSim();
  });
  el.simChSlider.addEventListener("input", function () {
    state.simCh = Number(el.simChSlider.value);
    emitSim();
  });
  el.simOffSlider.addEventListener("input", function () {
    state.simOffset = Number(el.simOffSlider.value);
    emitSim();
  });
  el.simOffRoadBtn.addEventListener("click", function () {
    stopSimDrive();
    state.simOffset = state.simOffset > 50 ? 0 : 75;
    el.simOffSlider.value = String(state.simOffset);
    emitSim();
  });
  el.simDriveBtn.addEventListener("click", function () {
    if (state.simTimer) {
      stopSimDrive();
      return;
    }
    el.simDriveBtn.textContent = "Pause";
    var align = getAlignment(state.simAlignmentId);
    state.simTimer = setInterval(function () {
      state.simCh += align.kind === "spine" ? 25 : 10;
      if (state.simCh > align.maxCh) state.simCh = align.minCh;
      el.simChSlider.value = String(state.simCh);
      emitSim();
    }, 300);
  });
})();
