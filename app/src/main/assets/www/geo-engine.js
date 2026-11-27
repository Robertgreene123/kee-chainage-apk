/**
 * Old-Android-WebView-safe offline chainage projection engine v7.
 * Plain direction labels ("To Entebbe" / "To Busega"), clean no-prefix formatting
 * for map ticks ("11+750", "0+200"), and single-code photo stamp formatter ("Km1+000", "Mpala AK0+300").
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.KEEGeo = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  var EARTH_RADIUS_M = 6378137.0;
  var DEG_TO_RAD = Math.PI / 180.0;
  var RAD_TO_DEG = 180.0 / Math.PI;

  var MEDIAN_HALF_WIDTH_M = 2.5;
  var OFF_ALIGNMENT_THRESHOLD_M = 50.0;
  var JUNCTION_HYSTERESIS_M = 12.0;
  var BRIDGE_OVERLAP_THRESHOLD_M = 24.0;
  var BBOX_PAD_DEG = 0.0025;

  function pad3(n) {
    var s = String(n);
    while (s.length < 3) s = "0" + s;
    return s;
  }

  function formatNoPrefix(meters) {
    if (!isFinite(meters)) return "--+---";
    var clamped = Math.max(0, Math.round(meters));
    var km = Math.floor(clamped / 1000);
    var rem = clamped % 1000;
    return km + "+" + pad3(rem);
  }

  function formatChainage(meters, prefix) {
    var pfx = prefix || "K";
    if (!isFinite(meters)) return pfx + "--+---";
    return pfx + formatNoPrefix(meters);
  }

  function formatDistance(meters) {
    if (!isFinite(meters)) return "—";
    var abs = Math.abs(meters);
    if (abs >= 1000) return (abs / 1000).toFixed(2) + " km";
    if (abs >= 100) return Math.round(abs) + " m";
    return abs.toFixed(1) + " m";
  }

  /**
   * Compute single clean watermark stamp text for offline site photos (NO coordinates).
   * - Mainline: "Km1+000"
   * - Munyonyo Spur (to Lweza): "LK0+650"
   * - Interchange Ramps: "Mpala AK0+300", "Busega BK0+200", etc.
   */
  function formatPhotoStamp(resolved) {
    if (!resolved) {
      return { text: "Km0+000", badge: "", color: "#F59E0B" };
    }
    if (resolved.kind === "ramp") {
      var rampCodeCh =
        resolved.code === "ACCESS"
          ? "ACCESS " + formatNoPrefix(resolved.chainage)
          : formatChainage(resolved.chainage, resolved.prefix);
      return {
        text: resolved.groupShort + " " + rampCodeCh,
        badge: resolved.code === "ACCESS" ? "ACC" : resolved.code,
        color: resolved.pillBg || resolved.color || "#DC2626"
      };
    }
    if (resolved.alignmentId === "lk_spur") {
      return {
        text: formatChainage(resolved.chainage, "LK"),
        badge: "LK",
        color: resolved.pillBg || "#0369A1"
      };
    }
    return {
      text: "Km" + formatNoPrefix(resolved.chainage),
      badge: "",
      color: "#F59E0B"
    };
  }

  function withinBbox(lat, lon, bbox, padDeg) {
    if (!bbox) return true;
    return (
      lat >= bbox.minLat - padDeg &&
      lat <= bbox.maxLat + padDeg &&
      lon >= bbox.minLon - padDeg &&
      lon <= bbox.maxLon + padDeg
    );
  }

  function projectOntoAlignment(lat, lon, alignment) {
    var pts = alignment.points;
    var n = pts.length;
    if (n < 2) return null;

    var cosLat = Math.cos(lat * DEG_TO_RAD);
    var metersPerDegLat = EARTH_RADIUS_M * DEG_TO_RAD;
    var metersPerDegLon = metersPerDegLat * cosLat;

    var bestDistSq = Infinity;
    var bestSegIdx = 0;
    var bestU = 0;
    var bestSignedOffset = 0;
    var bestSnappedLat = pts[0][1];
    var bestSnappedLon = pts[0][2];
    var bestBearing = 0;

    for (var i = 0; i < n - 1; i++) {
      var aLat = pts[i][1];
      var aLon = pts[i][2];
      var bLat = pts[i + 1][1];
      var bLon = pts[i + 1][2];

      var tx = (bLon - aLon) * metersPerDegLon;
      var ty = (bLat - aLat) * metersPerDegLat;
      var px = (lon - aLon) * metersPerDegLon;
      var py = (lat - aLat) * metersPerDegLat;

      var tLenSq = tx * tx + ty * ty;
      if (tLenSq < 1e-9) continue;

      var u = (px * tx + py * ty) / tLenSq;
      if (u < 0) u = 0;
      else if (u > 1) u = 1;

      var dx = px - u * tx;
      var dy = py - u * ty;
      var distSq = dx * dx + dy * dy;

      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestSegIdx = i;
        bestU = u;
        var tLen = Math.sqrt(tLenSq);
        var cross = tx * py - ty * px;
        var dist = Math.sqrt(distSq);
        bestSignedOffset = u > 0 && u < 1 ? cross / tLen : cross >= 0 ? dist : -dist;
        bestSnappedLat = aLat + u * (bLat - aLat);
        bestSnappedLon = aLon + u * (bLon - aLon);
        bestBearing = (Math.atan2(tx, ty) * RAD_TO_DEG + 360) % 360;
      }
    }

    var chA = pts[bestSegIdx][0];
    var chB = pts[bestSegIdx + 1][0];
    var chainage = chA + bestU * (chB - chA);
    var distanceM = Math.sqrt(bestDistSq);
    var prefix = alignment.prefix || "K";

    return {
      alignmentId: alignment.id,
      alignmentName: alignment.name,
      alignmentShortName: alignment.shortName || alignment.name,
      group: alignment.group || alignment.name,
      groupShort: alignment.groupShort || alignment.shortName || alignment.name,
      code: alignment.code || prefix,
      prefix: prefix,
      kind: alignment.kind || "spine",
      desc: alignment.desc || "",
      color: alignment.color || "#F59E0B",
      pillBg: alignment.pillBg || "#0F172A",
      fixedBound: alignment.fixedBound || null,
      chainage: chainage,
      formattedChainage: formatChainage(chainage, prefix),
      signedOffsetM: bestSignedOffset,
      distanceM: distanceM,
      snappedLat: bestSnappedLat,
      snappedLon: bestSnappedLon,
      bearingDeg: bestBearing,
      segmentIndex: bestSegIdx
    };
  }

  function resolvePosition(lat, lon, alignments, options) {
    var opts = options || {};
    var lockMode = opts.lockMode || "auto";
    var previousAlignmentId = opts.previousAlignmentId || null;
    var medianHalfWidth = opts.medianHalfWidth !== undefined ? opts.medianHalfWidth : MEDIAN_HALF_WIDTH_M;
    var offThreshold = opts.offAlignmentThreshold !== undefined ? opts.offAlignmentThreshold : OFF_ALIGNMENT_THRESHOLD_M;
    var hysteresis = opts.junctionHysteresis !== undefined ? opts.junctionHysteresis : JUNCTION_HYSTERESIS_M;

    var candidates = [];
    for (var i = 0; i < alignments.length; i++) {
      var a = alignments[i];
      if (
        a.id === lockMode ||
        a.id === previousAlignmentId ||
        a.kind === "spine" ||
        withinBbox(lat, lon, a.bbox, BBOX_PAD_DEG)
      ) {
        candidates.push(a);
      }
    }
    if (!candidates.length) candidates = alignments;

    var projections = [];
    for (var j = 0; j < candidates.length; j++) {
      projections.push({
        alignment: candidates[j],
        proj: projectOntoAlignment(lat, lon, candidates[j])
      });
    }
    projections.sort(function (x, y) {
      return x.proj.distanceM - y.proj.distanceM;
    });

    var chosen = projections[0];

    if (lockMode !== "auto") {
      for (var k = 0; k < projections.length; k++) {
        if (projections[k].alignment.id === lockMode) {
          chosen = projections[k];
          break;
        }
      }
    } else if (previousAlignmentId && chosen.alignment.id !== previousAlignmentId) {
      for (var m = 0; m < projections.length; m++) {
        if (projections[m].alignment.id === previousAlignmentId) {
          if (projections[m].proj.distanceM - chosen.proj.distanceM < hysteresis) {
            chosen = projections[m];
          }
          break;
        }
      }
    }

    var alignment = chosen.alignment;
    var proj = chosen.proj;
    var offAlignment = proj.distanceM > offThreshold;

    // Plain Ugandan site wording: "To Entebbe" / "To Busega" / "Center"
    var sideCode = "MEDIAN";
    var plainBound = null;
    if (!offAlignment) {
      if (alignment.fixedBound) {
        sideCode = "RHS";
        plainBound = "To Busega";
      } else if (alignment.id === "mainline") {
        if (proj.signedOffsetM > medianHalfWidth) {
          sideCode = "LHS";
          plainBound = "To Entebbe";
        } else if (proj.signedOffsetM < -medianHalfWidth) {
          sideCode = "RHS";
          plainBound = "To Busega";
        } else {
          sideCode = "MEDIAN";
          plainBound = "Center";
        }
      }
    }

    var nearbyAlternatives = [];
    if (!offAlignment) {
      for (var p = 0; p < projections.length; p++) {
        var item = projections[p];
        if (item.alignment.id === alignment.id) continue;
        if (item.proj.distanceM <= BRIDGE_OVERLAP_THRESHOLD_M) {
          nearbyAlternatives.push({
            alignmentId: item.alignment.id,
            code: item.alignment.code,
            groupShort: item.alignment.groupShort,
            formattedChainage: item.proj.formattedChainage,
            color: item.alignment.color,
            pillBg: item.alignment.pillBg,
            distanceM: item.proj.distanceM
          });
          if (nearbyAlternatives.length >= 2) break;
        }
      }
    }

    return Object.assign({}, proj, {
      offAlignment: offAlignment,
      sideCode: sideCode,
      plainBound: plainBound,
      absOffsetM: Math.abs(proj.signedOffsetM),
      minCh: alignment.minCh,
      maxCh: alignment.maxCh,
      nearbyAlternatives: nearbyAlternatives
    });
  }

  function pointAtChainageOffset(alignment, targetCh, signedOffsetM) {
    var pts = alignment.points;
    var ch = Math.max(alignment.minCh, Math.min(alignment.maxCh, targetCh));
    var segIdx = 0;
    for (var i = 0; i < pts.length - 1; i++) {
      if (ch >= pts[i][0] && ch <= pts[i + 1][0]) {
        segIdx = i;
        break;
      }
    }
    var a = pts[segIdx];
    var b = pts[segIdx + 1];
    var span = b[0] - a[0] || 1;
    var u = (ch - a[0]) / span;
    var lat = a[1] + u * (b[1] - a[1]);
    var lon = a[2] + u * (b[2] - a[2]);

    if (!signedOffsetM) return { lat: lat, lon: lon };

    var cosLat = Math.cos(lat * DEG_TO_RAD);
    var mPerDegLat = EARTH_RADIUS_M * DEG_TO_RAD;
    var mPerDegLon = mPerDegLat * cosLat;
    var tx = (b[2] - a[2]) * mPerDegLon;
    var ty = (b[1] - a[1]) * mPerDegLat;
    var len = Math.sqrt(tx * tx + ty * ty) || 1;
    var nx = -ty / len;
    var ny = tx / len;
    return {
      lat: lat + (ny * signedOffsetM) / mPerDegLat,
      lon: lon + (nx * signedOffsetM) / mPerDegLon
    };
  }

  function bearingBetween(lat1, lon1, lat2, lon2) {
    var cosLat = Math.cos(((lat1 + lat2) * 0.5) * DEG_TO_RAD);
    var dN = (lat2 - lat1) * EARTH_RADIUS_M * DEG_TO_RAD;
    var dE = (lon2 - lon1) * EARTH_RADIUS_M * DEG_TO_RAD * cosLat;
    var dist = Math.sqrt(dN * dN + dE * dE);
    return {
      distanceM: dist,
      bearingDeg: (Math.atan2(dE, dN) * RAD_TO_DEG + 360) % 360
    };
  }

  return {
    MEDIAN_HALF_WIDTH_M: MEDIAN_HALF_WIDTH_M,
    OFF_ALIGNMENT_THRESHOLD_M: OFF_ALIGNMENT_THRESHOLD_M,
    JUNCTION_HYSTERESIS_M: JUNCTION_HYSTERESIS_M,
    BRIDGE_OVERLAP_THRESHOLD_M: BRIDGE_OVERLAP_THRESHOLD_M,
    formatNoPrefix: formatNoPrefix,
    formatChainage: formatChainage,
    formatDistance: formatDistance,
    formatPhotoStamp: formatPhotoStamp,
    projectOntoAlignment: projectOntoAlignment,
    resolvePosition: resolvePosition,
    pointAtChainageOffset: pointAtChainageOffset,
    bearingBetween: bearingBetween
  };
});
