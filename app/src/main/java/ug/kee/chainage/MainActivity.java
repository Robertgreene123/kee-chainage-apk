package ug.kee.chainage;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.util.Locale;

/**
 * Ultra-lean pure-Java Android host for KEE Chainage Earth.
 * - Zero Google Play Services dependency (works on all budget/Huawei/Itel/Tecno/Infinix phones).
 * - Serves all 672 pre-bundled high-detail satellite tiles locally via WebViewAssetLoader.
 * - Pushes native OS GPS fixes directly into the JS engine for instant, reliable offline tracking.
 */
public class MainActivity extends Activity implements LocationListener {

    private static final int REQ_LOCATION = 1001;
    private static final String ENTRY_URL = "https://appassets.androidplatform.net/assets/www/index.html";

    private WebView webView;
    private LocationManager locationManager;
    private boolean pageReady = false;
    private Location lastGpsLocation = null;
    private long lastGpsFixElapsedMs = 0L;
    private Location pendingLocation = null;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep screen awake natively while app is open on site
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF0B1220);
        setContentView(webView);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && "appassets.androidplatform.net".equals(uri.getHost())) {
                    return assetLoader.shouldInterceptRequest(uri);
                }
                // Block any unexpected external traffic so the APK is strictly 100% offline
                return new WebResourceResponse("text/plain", "UTF-8", 404, "Offline", null, null);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                pageReady = true;
                if (pendingLocation != null) {
                    pushLocationToJs(pendingLocation);
                }
                checkAndStartLocation();
            }
        });

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        webView.loadUrl(ENTRY_URL);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (pageReady) {
            checkAndStartLocation();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopLocationUpdates();
    }

    @Override
    protected void onDestroy() {
        stopLocationUpdates();
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void checkAndStartLocation() {
        if (!hasLocationPermission()) {
            pushStatusToJs("denied", "Tap below and allow Location to show live chainage.");
            requestPermissions(
                    new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                    },
                    REQ_LOCATION
            );
            return;
        }
        startLocationUpdates();
    }

    @SuppressLint("MissingPermission")
    private void startLocationUpdates() {
        if (locationManager == null || !hasLocationPermission()) return;

        boolean gpsEnabled = false;
        boolean netEnabled = false;
        try {
            gpsEnabled = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (Exception ignored) {}
        try {
            netEnabled = locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception ignored) {}

        if (!gpsEnabled && !netEnabled) {
            pushStatusToJs("gps_off", "Phone GPS is OFF. Tap below to switch Location ON.");
            return;
        }

        stopLocationUpdates();
        pushStatusToJs("searching", "Finding GPS satellites…");

        if (gpsEnabled) {
            try {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this);
                Location last = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                if (last != null && (System.currentTimeMillis() - last.getTime()) < 180_000L) {
                    onLocationChanged(last);
                }
            } catch (Exception ignored) {}
        }

        if (netEnabled) {
            try {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 2500L, 0f, this);
                Location lastNet = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                if (lastGpsLocation == null && lastNet != null && (System.currentTimeMillis() - lastNet.getTime()) < 120_000L) {
                    onLocationChanged(lastNet);
                }
            } catch (Exception ignored) {}
        }
    }

    private void stopLocationUpdates() {
        if (locationManager != null) {
            try {
                locationManager.removeUpdates(this);
            } catch (Exception ignored) {}
        }
    }

    @Override
    public void onLocationChanged(Location location) {
        if (location == null) return;
        long now = SystemClock.elapsedRealtime();

        if (LocationManager.GPS_PROVIDER.equals(location.getProvider())) {
            lastGpsLocation = location;
            lastGpsFixElapsedMs = now;
            pushLocationToJs(location);
        } else {
            // Only use rough network fix if we haven't had a fresh satellite GPS fix in the last 12 seconds
            if (lastGpsLocation == null || (now - lastGpsFixElapsedMs) > 12_000L) {
                pushLocationToJs(location);
            }
        }
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {
        if (LocationManager.GPS_PROVIDER.equals(provider)) {
            startLocationUpdates();
        }
    }

    @Override
    public void onProviderDisabled(String provider) {
        if (LocationManager.GPS_PROVIDER.equals(provider)) {
            pushStatusToJs("gps_off", "Phone GPS is OFF. Tap below to switch Location ON.");
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_LOCATION) {
            if (hasLocationPermission()) {
                startLocationUpdates();
            } else {
                pushStatusToJs("denied", "Location permission is required. Tap below to allow.");
            }
        }
    }

    private void pushLocationToJs(final Location loc) {
        pendingLocation = loc;
        if (!pageReady || webView == null) return;
        final String js = String.format(
                Locale.US,
                "window.onNativeGps && window.onNativeGps(%.7f, %.7f, %.1f);",
                loc.getLatitude(),
                loc.getLongitude(),
                loc.hasAccuracy() ? loc.getAccuracy() : 25.0f
        );
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                webView.evaluateJavascript(js, null);
            }
        });
    }

    private void pushStatusToJs(final String code, final String message) {
        if (!pageReady || webView == null) return;
        final String safeMsg = message.replace("\\", "\\\\").replace("'", "\\'");
        final String js = "window.onNativeGpsStatus && window.onNativeGpsStatus('" + code + "', '" + safeMsg + "');";
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                webView.evaluateJavascript(js, null);
            }
        });
    }

    public class AndroidBridge {
        @JavascriptInterface
        public void copyText(final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                        if (cm != null) {
                            cm.setPrimaryClip(ClipData.newPlainText("KEE Chainage", text));
                        }
                    } catch (Exception ignored) {}
                }
            });
        }

        @JavascriptInterface
        public void requestGpsPermission() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!hasLocationPermission()) {
                        requestPermissions(
                                new String[]{
                                        Manifest.permission.ACCESS_FINE_LOCATION,
                                        Manifest.permission.ACCESS_COARSE_LOCATION
                                },
                                REQ_LOCATION
                        );
                    } else {
                        startLocationUpdates();
                    }
                }
            });
        }

        @JavascriptInterface
        public void openLocationSettings() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS));
                    } catch (Exception ignored) {}
                }
            });
        }
    }
}
