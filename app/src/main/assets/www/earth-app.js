(function () {
  "use strict";

  var ALIGNMENTS = KEE_ALIGNMENT_DATA.alignments;
  var Geo = window.KEEGeo;

  var WEAK_GPS_THRESHOLD_M = 30;
  var MANUAL_BRIDGE_RELEASE_M = 38;
  var AUTO_RESUME_FOLLOW_MS = 10000;
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
    headingUp: true,
    smoothedHeadingDeg: null,
    prevTrackPt: null,
    autoResumeTimer: null,
    dragStartPt: null,
    lastFix: null,
    lastResolved: null,
    lastStatusCode: null,
    simActive: false,
    simTimer: null,
    simAlignmentId: "mainline",
    simCh: 11720,
    simOffset: 0,
    copyTimer: null,
    photoToastTimer: null
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
    compassBtn: document.getElementById("compassBtn"),
    compassSvg: document.getElementById("compassSvg"),
    cameraBtn: document.getElementById("cameraBtn"),
    followBtn: document.getElementById("followBtn"),
    photoToast: document.getElementById("photoToast"),
    photoToastText: document.getElementById("photoToastText"),
    sharePhotoBtn: document.getElementById("sharePhotoBtn"),
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

  // Fix leaflet-rotate float t.y z-index bug so integer CSS z-index always stacks properly
  if (L.Marker && L.Marker.prototype && L.Marker.prototype._resetZIndex) {
    var origResetZIndex = L.Marker.prototype._resetZIndex;
    L.Marker.prototype._resetZIndex = function () {
      this._zIndex = Math.round(this._zIndex || 0);
      return origResetZIndex.call(this);
    };
  }

  // --- Satellite-Only Dual-Layer Rotatable Map (100% Pre-Bundled Inside APK) ---
  var map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
    fadeAnimation: false,
    rotate: true,
    bearing: 0,
    touchRotate: true,
    shiftKeyRotate: true,
    rotateControl: false,
    maxZoom: 19,
    minZoom: 12
  });

  L.tileLayer(LOCAL_TILE_URL, {
    minZoom: 12,
    maxZoom: 19,
    maxNativeZoom: 16,
    keepBuffer: 4,
    zIndex: 1,
    errorTileUrl: TRANSPARENT_TILE,
    attribution: "Offline Satellite"
  }).addTo(map);

  L.tileLayer(LOCAL_TILE_URL, {
    minZoom: 17,
    maxZoom: 19,
    maxNativeZoom: 17,
    keepBuffer: 3,
    zIndex: 2,
    errorTileUrl: TRANSPARENT_TILE
  }).addTo(map);

  var isProgrammaticRotate = false;

  function setMapBearingSafe(deg) {
    if (!map.setBearing) return;
    isProgrammaticRotate = true;
    map.setBearing(deg);
    isProgrammaticRotate = false;
    updateCompassNeedle();
  }

  // Sync rotating compass needle whenever map rotates (two-finger twist or auto heading-up)
  function updateCompassNeedle() {
    var b = map.getBearing ? map.getBearing() : 0;
    el.compassSvg.style.transform = "rotate(" + b.toFixed(1) + "deg)";
  }

  map.on("rotate", function () {
    updateCompassNeedle();
    if (!isProgrammaticRotate && state.headingUp) {
      // User manually twisted the map with two fingers: keep their chosen angle until they tap Compass
      state.headingUp = false;
      el.compassBtn.classList.remove("active");
    }
  });

  // Smart Auto-Follow: ignore tiny accidental thumb touches or pinch-zoom; auto-resume after 10s
  function scheduleAutoResumeFollow() {
    if (state.autoResumeTimer) clearTimeout(state.autoResumeTimer);
    if (!state.lastFix) return;
    state.autoResumeTimer = setTimeout(function () {
      if (!state.followGps && state.lastFix && el.setupSheet.classList.contains("hidden")) {
        state.followGps = true;
        el.followBtn.classList.add("active");
        centerOnLiveFix(state.lastFix.lat, state.lastFix.lon);
      }
    }, AUTO_RESUME_FOLLOW_MS);
  }

  map.on("dragstart", function () {
    state.dragStartPt = map.latLngToContainerPoint(map.getCenter());
  });

  map.on("dragend", function () {
    if (!state.dragStartPt) return;
    var endPt = map.latLngToContainerPoint(map.getCenter());
    var movedPx = Math.sqrt(
      Math.pow(endPt.x - state.dragStartPt.x, 2) + Math.pow(endPt.y - state.dragStartPt.y, 2)
    );
    state.dragStartPt = null;
    if (movedPx > 45) {
      state.followGps = false;
      el.followBtn.classList.remove("active");
      scheduleAutoResumeFollow();
    }
  });

  // If user manually twists map with two fingers, pause auto Heading-Up until they tap compass
  map.on("rotateend", function () {
    refreshStationLabels();
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

  // --- Decluttered Style 1 Labels (All 50 m Shown, Always Upright at Every Rotation) ---
  var labelsLayer = L.layerGroup().addTo(map);

  function refreshStationLabels() {
    labelsLayer.clearLayers();
    var z = map.getZoom();
    var viewBounds = map.getBounds().pad(0.18);
    var placedBoxes = [];

    function tryPlace(lat, lon, halfW, halfH, html, zOffset, pxOffX, pxOffY) {
      var pt = map.latLngToContainerPoint([lat, lon]);
      var tx = pt.x + (pxOffX || 0);
      var ty = pt.y + (pxOffY || 0);
      for (var k = 0; k < placedBoxes.length; k++) {
        var b = placedBoxes[k];
        if (Math.abs(tx - b.x) < halfW + b.w && Math.abs(ty - b.y) < halfH + b.h) {
          return false;
        }
      }
      placedBoxes.push({ x: tx, y: ty, w: halfW, h: halfH });
      var targetLL = pxOffX || pxOffY ? map.containerPointToLatLng([tx, ty]) : [lat, lon];
      var icon = L.divIcon({ className: "", html: html, iconSize: [0, 0] });
      L.marker(targetLL, { icon: icon, interactive: false, zIndexOffset: zOffset || 0 }).addTo(labelsLayer);
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

    // 2) Ramp & LK identity badges + Start ● (AK0+000) & End ■ (AK0+545) markers
    if (z >= 15) {
      for (var r = 0; r < ALIGNMENTS.length; r++) {
        var ra = ALIGNMENTS[r];
        if (ra.kind === "spine" && ra.id !== "lk_spur") continue;
        if (
          ra.bbox.maxLat < viewBounds.getSouth() ||
          ra.bbox.minLat > viewBounds.getNorth() ||
          ra.bbox.maxLon < viewBounds.getWest() ||
          ra.bbox.minLon > viewBounds.getEast()
        ) {
          continue;
        }

        // Bold colored identity badge (AK, BK, CK, DK, UK, RK, LK)
        var midIdx = ra.id === "lk_spur" ? Math.min(25, ra.points.length - 1) : Math.floor(ra.points.length / 2);
        var midPt = ra.points[midIdx];
        if (viewBounds.contains([midPt[1], midPt[2]])) {
          var badgeTxt = ra.code === "ACCESS" ? "ACCESS" : ra.code;
          tryPlace(
            midPt[1],
            midPt[2],
            18,
            11,
            '<div class="ramp-code-badge" style="background:' + ra.pillBg + '">' + badgeTxt + "</div>",
            280
          );
        }

        // Green Start Circle ● + Start Code Pill (e.g. AK0+000) at z >= 16
        if (z >= 16) {
          var stPt = ra.points[0];
          if (viewBounds.contains([stPt[1], stPt[2]])) {
            var stDot = L.divIcon({
              className: "",
              html: '<div class="ramp-start-dot"></div>',
              iconSize: [11, 11],
              iconAnchor: [5, 5]
            });
            L.marker([stPt[1], stPt[2]], { icon: stDot, interactive: false, zIndexOffset: 200 }).addTo(labelsLayer);

            if (z >= 17) {
              var stLbl = ra.code === "ACCESS" ? "ACC0+000" : Geo.formatChainage(ra.minCh, ra.prefix);
              var stOffsets = [[24, -14], [-24, -14], [24, 14], [-24, 14]];
              for (var so = 0; so < stOffsets.length; so++) {
                if (
                  tryPlace(
                    stPt[1],
                    stPt[2],
                    26,
                    9,
                    '<div class="start-code-pill">' + stLbl + "</div>",
                    240,
                    stOffsets[so][0],
                    stOffsets[so][1]
                  )
                ) {
                  break;
                }
              }
            }
          }

          // Colored End Square ■ + End Code Pill (e.g. AK0+545) at z >= 16
          var enPt = ra.points[ra.points.length - 1];
          if (viewBounds.contains([enPt[1], enPt[2]])) {
            var enSq = L.divIcon({
              className: "",
              html: '<div class="ramp-end-sq" style="background:' + ra.color + '"></div>',
              iconSize: [11, 11],
              iconAnchor: [5, 5]
            });
            L.marker([enPt[1], enPt[2]], { icon: enSq, interactive: false, zIndexOffset: 200 }).addTo(labelsLayer);

            var enLbl = ra.code === "ACCESS" ? "ACC" + Geo.formatNoPrefix(ra.maxCh) : Geo.formatChainage(ra.maxCh, ra.prefix);
            var enOffsets = [[26, -12], [-26, -12], [26, 12], [-26, 12]];
            for (var eo = 0; eo < enOffsets.length; eo++) {
              if (
                tryPlace(
                  enPt[1],
                  enPt[2],
                  27,
                  9,
                  '<div class="end-code-pill" style="background:' + ra.pillBg + '">' + enLbl + "</div>",
                  250,
                  enOffsets[eo][0],
                  enOffsets[eo][1]
                )
              ) {
                break;
              }
            }
          }
        }
      }
    }

    // 3) Mainline pills (NO "K", e.g. 11+750) + Ramps/LK clean haloed numbers (0+050, 0+100)
    var mainStep = z >= 16 ? 50 : z === 15 ? 200 : z === 14 ? 1000 : 5000;
    var rampStep = z >= 17 ? 50 : z === 16 ? 100 : null;

    for (var ai = 0; ai < ALIGNMENTS.length; ai++) {
      var al = ALIGNMENTS[ai];
      var isMain = al.id === "mainline";
      var isRhs = al.id === "mainline_rhs";
      var isLk = al.id === "lk_spur";

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

      if (isMain || isRhs) {
        for (var pi = 0; pi < al.points.length; pi++) {
          var ch = al.points[pi][0];
          var lat = al.points[pi][1];
          var lon = al.points[pi][2];
          var isEnd = pi === 0 || pi === al.points.length - 1;
          var onStep = Math.abs(ch % mainStep) < 0.1;
          if (!isEnd && !onStep) continue;
          if (z >= 14 && !viewBounds.contains([lat, lon])) continue;
          if (isRhs && isEnd) continue;

          // Mainline without K: "11+750", "12+000" (at overview z<=14 keep "10+000" or "K10")
          var txt = z <= 14 && Math.abs(ch % 1000) < 0.1
            ? Math.round(ch / 1000) + "+000"
            : Geo.formatNoPrefix(ch);

          tryPlace(
            lat,
            lon,
            23,
            9,
            '<div class="main-tick-pill">' + txt + "</div>",
            Math.abs(ch % 1000) < 0.1 ? 180 : 120
          );
        }
      } else {
        // Ramps & LK Spur: crisp white 50 m dot on line + clean haloed "0+050", "0+100" (keeps the 0, drops prefix!)
        var step = isLk ? (z >= 16 ? 50 : z === 15 ? 200 : z === 14 ? 1000 : null) : rampStep;
        if (!step) continue;

        for (var ri = 0; ri < al.points.length; ri++) {
          var rch = al.points[ri][0];
          var rlat = al.points[ri][1];
          var rlon = al.points[ri][2];
          if (ri === 0 || ri === al.points.length - 1) continue;
          if (Math.abs(rch % step) >= 0.1) continue;
          if (!viewBounds.contains([rlat, rlon])) continue;

          var is100 = Math.abs(rch % 100) < 0.1;

          // Place crisp white 50 m dot right on the road centerline
          var dotIcon = L.divIcon({
            className: "",
            html: '<div class="tick-dot' + (is100 ? " maj100" : "") + '"></div>',
            iconSize: [is100 ? 9 : 7, is100 ? 9 : 7],
            iconAnchor: [is100 ? 4 : 3, is100 ? 4 : 3]
          });
          L.marker([rlat, rlon], { icon: dotIcon, interactive: false, zIndexOffset: -400 }).addTo(labelsLayer);

          // Offset text cleanly perpendicular to road segment in screen pixels
          var pPrev = map.latLngToContainerPoint([al.points[Math.max(0, ri - 1)][1], al.points[Math.max(0, ri - 1)][2]]);
          var pNext = map.latLngToContainerPoint([al.points[Math.min(al.points.length - 1, ri + 1)][1], al.points[Math.min(al.points.length - 1, ri + 1)][2]]);
          var dx = pNext.x - pPrev.x;
          var dy = pNext.y - pPrev.y;
          var nm = Math.sqrt(dx * dx + dy * dy) || 1;
          var offX = (-dy / nm) * 18;
          var offY = (dx / nm) * 18;

          var rlbl = Geo.formatNoPrefix(rch); // "0+050", "0+100", "0+200", "1+250"
          tryPlace(
            rlat,
            rlon,
            18,
            8,
            '<div class="halo-tick' + (is100 ? "" : " sub50") + '">' + rlbl + "</div>",
            is100 ? 140 : 110,
            offX,
            offY
          );
        }
      }
    }
  }

  map.on("zoomend moveend", refreshStationLabels);
  refreshStationLabels();

  // --- Map Markers & Heading-Up Auto-Follow ---
  var gpsMarker = null;
  var gpsAccCircle = null;
  var tapMarker = null;

  function smoothAngle(prevDeg, nextDeg, alpha) {
    if (prevDeg === null || !isFinite(prevDeg)) return nextDeg;
    var diff = ((nextDeg - prevDeg + 540) % 360) - 180;
    return (prevDeg + alpha * diff + 360) % 360;
  }

  function centerOnLiveFix(lat, lon) {
    var targetZoom = Math.max(map.getZoom(), 17);
    // Shift camera 56 screen-px ahead (upward on screen) in exact rotated coordinates
    // so the blue dot sits ~58% down — safely below the top HUD card with maximum road ahead!
    var bearingRad = map._bearing || 0;
    var screenShift = L.point(0, -56).rotate(-bearingRad);
    var targetPx = map.project([lat, lon], targetZoom).add(screenShift);
    map.setView(map.unproject(targetPx, targetZoom), targetZoom, { animate: false });
  }

  function updateGpsMapMarker(lat, lon, accuracyM, bearingDeg, speedMs) {
    var icon = L.divIcon({
      className: "",
      html: '<div class="gps-live-marker"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10]
    });
    if (!gpsMarker) {
      gpsMarker = L.marker([lat, lon], { icon: icon, zIndexOffset: 1400 }).addTo(map);
    } else {
      gpsMarker.setLatLng([lat, lon]);
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

    // Derive reliable travel heading when moving (native bearing or displacement > 7 m)
    var measuredHeading = null;
    if (isFinite(bearingDeg) && bearingDeg >= 0 && isFinite(speedMs) && speedMs >= 1.2) {
      measuredHeading = bearingDeg;
    } else if (state.prevTrackPt) {
      var step = Geo.bearingBetween(state.prevTrackPt.lat, state.prevTrackPt.lon, lat, lon);
      if (step.distanceM >= 7.0) {
        measuredHeading = step.bearingDeg;
        state.prevTrackPt = { lat: lat, lon: lon };
      }
    } else {
      state.prevTrackPt = { lat: lat, lon: lon };
    }
    if (measuredHeading !== null && state.prevTrackPt) {
      state.prevTrackPt = { lat: lat, lon: lon };
    }

    if (state.headingUp && measuredHeading !== null && map.setBearing) {
      state.smoothedHeadingDeg = smoothAngle(state.smoothedHeadingDeg, measuredHeading, 0.35);
      // Rotate map counter-clockwise by travel heading so direction of travel points straight UP!
      setMapBearingSafe(-state.smoothedHeadingDeg);
    }

    if (state.followGps) {
      centerOnLiveFix(lat, lon);
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

    var displayCh = res.alignmentId === "mainline" || res.alignmentId === "mainline_rhs"
      ? "Km" + Geo.formatNoPrefix(res.chainage)
      : res.formattedChainage;

    var extraDist =
      state.lastResolved && state.lastResolved.alignmentId === res.alignmentId
        ? '<div class="popup-line">Distance from you: <b>' + Geo.formatDistance(res.chainage - state.lastResolved.chainage) + "</b></div>"
        : "";

    var html =
      '<div class="popup-head">' + headerTitle + "</div>" +
      '<div class="popup-ch" style="color:' + res.color + '">' + displayCh + "</div>" +
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

  // --- Top Banner HUD Rendering (Kept intact with To Entebbe / To Busega) ---
  function renderChainageMarkup(formatted, prefixColor) {
    var m = formatted.match(/^([A-Za-z]+)(\d+)\+(\d{3})$/);
    if (!m) return formatted;
    return '<span class="ch-k" style="color:' + prefixColor + '">' + m[1] + "</span>" + m[2] + '<span class="ch-plus">+</span>' + m[3];
  }

  function handlePositionUpdate(lat, lon, accuracyM, bearingDeg, speedMs) {
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
    state.lastFix = { lat: lat, lon: lon, accuracyM: accuracyM, bearingDeg: bearingDeg, speedMs: speedMs };
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

    var heroFormatted = resolved.formattedChainage;
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
      heroFormatted = "Km" + Geo.formatNoPrefix(resolved.chainage);
    }

    el.chainageReadout.innerHTML = renderChainageMarkup(heroFormatted, resolved.color);

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

    updateGpsMapMarker(lat, lon, accuracyM, bearingDeg, speedMs);
  }

  // --- Tap Giant Chainage to Copy Clean Text for WhatsApp ---
  el.chainageReadout.addEventListener("click", function () {
    if (!state.lastResolved) return;
    var stamp = Geo.formatPhotoStamp(state.lastResolved);
    var copyStr = stamp.text + (state.lastResolved.plainBound ? " (" + state.lastResolved.plainBound + ")" : "");
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

  // --- Offline Native Camera Button & Photo Callbacks ---
  el.cameraBtn.addEventListener("click", function () {
    var stamp = Geo.formatPhotoStamp(state.lastResolved);
    if (window.AndroidBridge && window.AndroidBridge.capturePhoto) {
      window.AndroidBridge.capturePhoto(stamp.text, stamp.badge, stamp.color);
    } else {
      // Friendly preview message when tested outside Android APK
      showPhotoToast("Camera stamp preview: " + stamp.text, false);
    }
  });

  function showPhotoToast(msg, showShare) {
    el.photoToastText.textContent = msg;
    if (showShare) el.sharePhotoBtn.classList.remove("hidden");
    else el.sharePhotoBtn.classList.add("hidden");
    el.photoToast.classList.remove("hidden");
    if (state.photoToastTimer) clearTimeout(state.photoToastTimer);
    state.photoToastTimer = setTimeout(function () {
      el.photoToast.classList.add("hidden");
    }, 7000);
  }

  window.onPhotoSaved = function (stampText) {
    showPhotoToast("Saved: " + stampText + " photo", true);
  };

  window.onPhotoError = function (msg) {
    showPhotoToast(msg || "Could not save photo", false);
  };

  el.sharePhotoBtn.addEventListener("click", function () {
    if (window.AndroidBridge && window.AndroidBridge.shareLastPhoto) {
      window.AndroidBridge.shareLastPhoto();
    }
  });

  // --- Compass / Heading-Up Toggle ---
  el.compassBtn.addEventListener("click", function () {
    state.headingUp = !state.headingUp;
    if (state.headingUp) {
      el.compassBtn.classList.add("active");
      if (state.smoothedHeadingDeg !== null) {
        setMapBearingSafe(-state.smoothedHeadingDeg);
      }
    } else {
      el.compassBtn.classList.remove("active");
      setMapBearingSafe(0);
    }
    if (state.followGps && state.lastFix) {
      centerOnLiveFix(state.lastFix.lat, state.lastFix.lon);
    } else {
      refreshStationLabels();
    }
  });

  // --- Native Android GPS Bridge Hooks ---
  window.onNativeGps = function (lat, lon, accuracyM, bearingDeg, speedMs) {
    if (state.simActive) return;
    handlePositionUpdate(lat, lon, accuracyM, bearingDeg, speedMs);
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

  if (!window.AndroidBridge && navigator.geolocation) {
    navigator.geolocation.watchPosition(
      function (pos) {
        if (!state.simActive) {
          handlePositionUpdate(
            pos.coords.latitude,
            pos.coords.longitude,
            pos.coords.accuracy,
            pos.coords.heading !== null ? pos.coords.heading : -1,
            pos.coords.speed !== null ? pos.coords.speed : 0
          );
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
    handlePositionUpdate(state.lastFix.lat, state.lastFix.lon, state.lastFix.accuracyM, -1, 0);
  });

  el.retryGpsBtn.addEventListener("click", function () {
    if (window.AndroidBridge) {
      if (state.lastStatusCode === "gps_off") window.AndroidBridge.openLocationSettings();
      else window.AndroidBridge.requestGpsPermission();
    }
  });

  el.followBtn.addEventListener("click", function () {
    state.followGps = true;
    el.followBtn.classList.add("active");
    if (state.autoResumeTimer) clearTimeout(state.autoResumeTimer);
    if (state.lastFix) {
      centerOnLiveFix(state.lastFix.lat, state.lastFix.lon);
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
        setMapBearingSafe(0);
        map.setView([target.lat, target.lon], target.zoom, { animate: false });
      });
    })(el.jumpBtns[ji]);
  }

  el.fitBtn.addEventListener("click", function () {
    state.followGps = false;
    el.followBtn.classList.remove("active");
    el.setupSheet.classList.add("hidden");
    setMapBearingSafe(0);
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

  function emitSim(simSpeed) {
    var align = getAlignment(state.simAlignmentId);
    var pt = Geo.pointAtChainageOffset(align, state.simCh, state.simOffset);
    var ptAhead = Geo.pointAtChainageOffset(align, Math.min(align.maxCh, state.simCh + 15), state.simOffset);
    var brg = Geo.bearingBetween(pt.lat, pt.lon, ptAhead.lat, ptAhead.lon).bearingDeg;
    el.simLabel.textContent = Geo.formatChainage(state.simCh, align.prefix) + " • " + state.simOffset + " m";
    handlePositionUpdate(pt.lat, pt.lon, 4, simSpeed > 0 ? brg : -1, simSpeed || 0);
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
    emitSim(0);
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
    emitSim(0);
  });
  el.simChSlider.addEventListener("input", function () {
    state.simCh = Number(el.simChSlider.value);
    emitSim(0);
  });
  el.simOffSlider.addEventListener("input", function () {
    state.simOffset = Number(el.simOffSlider.value);
    emitSim(0);
  });
  el.simOffRoadBtn.addEventListener("click", function () {
    stopSimDrive();
    state.simOffset = state.simOffset > 50 ? 0 : 75;
    el.simOffSlider.value = String(state.simOffset);
    emitSim(0);
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
      emitSim(14); // drives with live Heading-Up map rotation!
    }, 350);
  });
})();
