package ug.kee.chainage;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.SystemClock;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.content.FileProvider;
import androidx.exifinterface.media.ExifInterface;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Ultra-lean pure-Java Android host for KEE Chainage Earth v7.
 * - Zero Google Play Services dependency (works on all budget/Huawei/Itel/Tecno/Infinix phones).
 * - Serves all 672 pre-bundled high-detail satellite tiles locally via WebViewAssetLoader.
 * - Pushes native OS GPS fixes (with travel bearing & satellite clock) into the map engine.
 * - Launches phone's built-in Camera, burns Date + Time + Chainage stamp offline via Canvas,
 *   saves cleanly into Gallery (Pictures/KEE Chainage/), and supports 1-tap Share to WhatsApp.
 */
public class MainActivity extends Activity implements LocationListener {

    private static final int REQ_LOCATION = 1001;
    private static final int REQ_CAMERA = 1002;
    private static final int REQ_STORAGE = 1003;
    private static final String ENTRY_URL = "https://appassets.androidplatform.net/assets/www/index.html";

    private WebView webView;
    private LocationManager locationManager;
    private boolean pageReady = false;
    private Location lastGpsLocation = null;
    private long lastGpsFixElapsedMs = 0L;
    private long lastGpsUtcTimeMs = 0L;
    private Location pendingLocation = null;

    // Camera capture & stamping state
    private File tempCaptureFile = null;
    private String pendingStampText = "Km0+000";
    private String pendingCodeBadge = "";
    private String pendingAccentHex = "#F59E0B";
    private Uri lastSavedPhotoUri = null;
    private String lastSavedMime = "image/jpeg";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (savedInstanceState != null) {
            String savedPath = savedInstanceState.getString("tempCapturePath");
            if (savedPath != null && !savedPath.isEmpty()) {
                tempCaptureFile = new File(savedPath);
            }
            pendingStampText = savedInstanceState.getString("pendingStampText", "Km0+000");
            pendingCodeBadge = savedInstanceState.getString("pendingCodeBadge", "");
            pendingAccentHex = savedInstanceState.getString("pendingAccentHex", "#F59E0B");
        }

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
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (tempCaptureFile != null) {
            outState.putString("tempCapturePath", tempCaptureFile.getAbsolutePath());
        }
        outState.putString("pendingStampText", pendingStampText);
        outState.putString("pendingCodeBadge", pendingCodeBadge);
        outState.putString("pendingAccentHex", pendingAccentHex);
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
            if (location.getTime() > 1_577_836_800_000L) { // sanity > 2020-01-01
                lastGpsUtcTimeMs = location.getTime();
            }
            pushLocationToJs(location);
        } else {
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
        } else if (requestCode == REQ_STORAGE) {
            launchNativeCamera(true);
        }
    }

    private void pushLocationToJs(final Location loc) {
        pendingLocation = loc;
        if (!pageReady || webView == null) return;
        final float acc = loc.hasAccuracy() ? loc.getAccuracy() : 25.0f;
        final float brg = loc.hasBearing() ? loc.getBearing() : -1.0f;
        final float spd = loc.hasSpeed() ? loc.getSpeed() : 0.0f;
        final String js = String.format(
                Locale.US,
                "window.onNativeGps && window.onNativeGps(%.7f, %.7f, %.1f, %.1f, %.2f);",
                loc.getLatitude(),
                loc.getLongitude(),
                acc,
                brg,
                spd
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
        final String safeMsg = escapeJs(message);
        final String js = "window.onNativeGpsStatus && window.onNativeGpsStatus('" + escapeJs(code) + "', '" + safeMsg + "');";
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                webView.evaluateJavascript(js, null);
            }
        });
    }

    private String escapeJs(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ");
    }

    // =========================================================================
    // NATIVE OFFLINE CAMERA + WATERMARK STAMP + GALLERY SAVE + 1-TAP SHARE
    // =========================================================================

    private long getReliableTimestampMs() {
        long nowElapsed = SystemClock.elapsedRealtime();
        // Use GPS satellite atomic clock if we received a GPS fix in the last 30 minutes
        if (lastGpsUtcTimeMs > 0L && (nowElapsed - lastGpsFixElapsedMs) < 1_800_000L) {
            return lastGpsUtcTimeMs + (nowElapsed - lastGpsFixElapsedMs);
        }
        return System.currentTimeMillis();
    }

    private void launchNativeCamera(boolean skipStoragePrompt) {
        try {
            // On Android 7-9, request WRITE_EXTERNAL_STORAGE once so photos land in public Gallery
            if (!skipStoragePrompt && Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
                if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_STORAGE);
                    return;
                }
            }

            tempCaptureFile = new File(getCacheDir(), "kee_capture_" + System.currentTimeMillis() + ".jpg");
            Uri photoUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", tempCaptureFile);

            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            intent.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
            intent.setClipData(ClipData.newRawUri("", photoUri));
            intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);

            if (intent.resolveActivity(getPackageManager()) != null) {
                startActivityForResult(intent, REQ_CAMERA);
            } else {
                notifyPhotoError("No camera app found on this phone.");
            }
        } catch (Exception e) {
            notifyPhotoError("Could not open camera: " + e.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_CAMERA) {
            if (resultCode == RESULT_OK && tempCaptureFile != null && tempCaptureFile.exists() && tempCaptureFile.length() > 1000) {
                final File captured = tempCaptureFile;
                final String stampText = pendingStampText;
                final String codeBadge = pendingCodeBadge;
                final String accentHex = pendingAccentHex;
                final long timestampMs = getReliableTimestampMs();

                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        processAndSaveStampedPhoto(captured, stampText, codeBadge, accentHex, timestampMs);
                    }
                }).start();
            } else {
                if (tempCaptureFile != null && tempCaptureFile.exists()) {
                    //noinspection ResultOfMethodCallIgnored
                    tempCaptureFile.delete();
                }
            }
        }
    }

    private void processAndSaveStampedPhoto(File srcFile, String stampText, String codeBadge, String accentHex, long timestampMs) {
        Bitmap decoded = null;
        Bitmap oriented = null;
        Bitmap stamped = null;
        try {
            // 1. Read dimensions & compute safe inSampleSize (cap ~2048px for 2GB RAM safety + full WhatsApp sharpness)
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(srcFile.getAbsolutePath(), opts);

            int maxDim = 2048;
            int sample = 1;
            int longest = Math.max(opts.outWidth, opts.outHeight);
            while (longest / (sample * 2) >= maxDim) {
                sample *= 2;
            }
            opts.inJustDecodeBounds = false;
            opts.inSampleSize = sample;
            opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
            decoded = BitmapFactory.decodeFile(srcFile.getAbsolutePath(), opts);
            if (decoded == null) {
                notifyPhotoError("Could not read captured photo.");
                return;
            }

            // 2. Apply exact EXIF orientation so photo is never rotated sideways
            int rotDeg = 0;
            try {
                ExifInterface exif = new ExifInterface(srcFile.getAbsolutePath());
                int ori = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
                if (ori == ExifInterface.ORIENTATION_ROTATE_90) rotDeg = 90;
                else if (ori == ExifInterface.ORIENTATION_ROTATE_180) rotDeg = 180;
                else if (ori == ExifInterface.ORIENTATION_ROTATE_270) rotDeg = 270;
            } catch (Exception ignored) {}

            int w = decoded.getWidth();
            int h = decoded.getHeight();
            float scale = 1.0f;
            if (Math.max(w, h) > maxDim) {
                scale = (float) maxDim / (float) Math.max(w, h);
            }

            if (rotDeg != 0 || scale < 0.99f) {
                Matrix m = new Matrix();
                if (scale < 0.99f) m.postScale(scale, scale);
                if (rotDeg != 0) m.postRotate(rotDeg);
                oriented = Bitmap.createBitmap(decoded, 0, 0, w, h, m, true);
                if (oriented != decoded) {
                    decoded.recycle();
                    decoded = null;
                }
            } else {
                oriented = decoded;
                decoded = null;
            }

            // 3. Burn clean Date + Time + Chainage stamp onto bottom card (NO coordinates)
            stamped = oriented.copy(Bitmap.Config.ARGB_8888, true);
            oriented.recycle();
            oriented = null;

            drawWatermarkOnBitmap(stamped, stampText, codeBadge, accentHex, timestampMs);

            // 4. Save at 92% JPEG quality into Pictures/KEE Chainage/
            String safeTag = stampText.replaceAll("[^A-Za-z0-9+_-]+", "_");
            String fileStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date(timestampMs));
            String fileName = "KEE_" + safeTag + "_" + fileStamp + ".jpg";

            Uri savedUri = saveBitmapToGallery(stamped, fileName);
            if (savedUri == null) {
                notifyPhotoError("Could not save photo to Gallery.");
                return;
            }

            lastSavedPhotoUri = savedUri;
            notifyPhotoSaved(stampText, fileName);
        } catch (Throwable t) {
            notifyPhotoError("Photo error: " + t.getMessage());
        } finally {
            if (decoded != null && !decoded.isRecycled()) decoded.recycle();
            if (oriented != null && !oriented.isRecycled()) oriented.recycle();
            if (stamped != null && !stamped.isRecycled()) stamped.recycle();
            if (srcFile != null && srcFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                srcFile.delete();
            }
        }
    }

    private void drawWatermarkOnBitmap(Bitmap bmp, String chainageLine, String codeBadge, String accentHex, long timestampMs) {
        int w = bmp.getWidth();
        int h = bmp.getHeight();
        int minSide = Math.min(w, h);
        Canvas canvas = new Canvas(bmp);

        int accentColor = Color.parseColor("#F59E0B");
        try {
            if (accentHex != null && accentHex.startsWith("#")) {
                accentColor = Color.parseColor(accentHex);
            }
        } catch (Exception ignored) {}

        float barH = Math.max(96f, minSide * 0.145f);
        float marginX = Math.max(18f, w * 0.032f);
        float marginBottom = Math.max(18f, h * 0.026f);
        float barTop = h - marginBottom - barH;
        float barBot = h - marginBottom;
        float radius = barH * 0.16f;

        // Translucent dark rounded background card
        Paint bgPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        bgPaint.setColor(Color.argb(218, 11, 18, 32));
        bgPaint.setStyle(Paint.Style.FILL);
        RectF cardRect = new RectF(marginX, barTop, w - marginX, barBot);
        canvas.drawRoundRect(cardRect, radius, radius, bgPaint);

        // Colored outer border
        Paint borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        borderPaint.setColor(accentColor);
        borderPaint.setAlpha(235);
        borderPaint.setStyle(Paint.Style.STROKE);
        borderPaint.setStrokeWidth(Math.max(2.5f, barH * 0.028f));
        canvas.drawRoundRect(cardRect, radius, radius, borderPaint);

        // Colored left accent stripe
        Paint stripePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        stripePaint.setColor(accentColor);
        stripePaint.setStyle(Paint.Style.FILL);
        float stripeLeft = marginX + barH * 0.13f;
        float stripeW = Math.max(7f, barH * 0.085f);
        RectF stripeRect = new RectF(stripeLeft, barTop + barH * 0.14f, stripeLeft + stripeW, barBot - barH * 0.14f);
        canvas.drawRoundRect(stripeRect, stripeW * 0.5f, stripeW * 0.5f, stripePaint);

        float textLeft = stripeLeft + stripeW + barH * 0.16f;
        float maxTextWidth = (w - marginX - barH * 0.14f) - textLeft;

        // Optional ramp code badge (e.g. AK, BK, UK, LK)
        float chStartX = textLeft;
        float topLineCenterY = barTop + barH * 0.37f;
        if (codeBadge != null && !codeBadge.isEmpty()) {
            Paint badgeTextPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
            badgeTextPaint.setColor(Color.WHITE);
            badgeTextPaint.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));
            badgeTextPaint.setTextSize(barH * 0.28f);
            Rect bBounds = new Rect();
            badgeTextPaint.getTextBounds(codeBadge, 0, codeBadge.length(), bBounds);
            float padH = barH * 0.11f;
            float padV = barH * 0.07f;
            float bw = bBounds.width() + padH * 2f;
            float bh = bBounds.height() + padV * 2f;
            RectF bRect = new RectF(chStartX, topLineCenterY - bh * 0.5f, chStartX + bw, topLineCenterY + bh * 0.5f);

            Paint bFill = new Paint(Paint.ANTI_ALIAS_FLAG);
            bFill.setColor(accentColor);
            canvas.drawRoundRect(bRect, bh * 0.24f, bh * 0.24f, bFill);

            Paint bStroke = new Paint(Paint.ANTI_ALIAS_FLAG);
            bStroke.setColor(Color.WHITE);
            bStroke.setStyle(Paint.Style.STROKE);
            bStroke.setStrokeWidth(Math.max(1.8f, barH * 0.018f));
            canvas.drawRoundRect(bRect, bh * 0.24f, bh * 0.24f, bStroke);

            Paint.FontMetrics fm = badgeTextPaint.getFontMetrics();
            float by = topLineCenterY - (fm.ascent + fm.descent) * 0.5f;
            canvas.drawText(codeBadge, chStartX + padH, by, badgeTextPaint);
            chStartX += bw + barH * 0.13f;
        }

        // Main Chainage line (auto-fits width cleanly)
        Paint chPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        chPaint.setColor(Color.WHITE);
        chPaint.setTypeface(Typeface.create(Typeface.MONOSPACE, Typeface.BOLD));
        float chSize = barH * 0.42f;
        chPaint.setTextSize(chSize);
        float availChW = (w - marginX - barH * 0.14f) - chStartX;
        float measuredChW = chPaint.measureText(chainageLine);
        if (measuredChW > availChW && availChW > 40f) {
            chPaint.setTextSize(chSize * (availChW / measuredChW));
        }
        Paint.FontMetrics chFm = chPaint.getFontMetrics();
        float chY = topLineCenterY - (chFm.ascent + chFm.descent) * 0.5f;
        canvas.drawText(chainageLine, chStartX, chY, chPaint);

        // Date & Time line (NO coordinates)
        String dateTime = new SimpleDateFormat("dd MMM yyyy  \u2022  hh:mm a", Locale.US).format(new Date(timestampMs));
        Paint dtPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        dtPaint.setColor(Color.rgb(203, 213, 225));
        dtPaint.setTypeface(Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD));
        float dtSize = barH * 0.24f;
        dtPaint.setTextSize(dtSize);
        if (dtPaint.measureText(dateTime) > maxTextWidth && maxTextWidth > 40f) {
            dtPaint.setTextSize(dtSize * (maxTextWidth / dtPaint.measureText(dateTime)));
        }
        float botLineCenterY = barTop + barH * 0.75f;
        Paint.FontMetrics dtFm = dtPaint.getFontMetrics();
        float dtY = botLineCenterY - (dtFm.ascent + dtFm.descent) * 0.5f;
        canvas.drawText(dateTime, textLeft, dtY, dtPaint);
    }

    private Uri saveBitmapToGallery(Bitmap bmp, String fileName) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
                values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
                values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/KEE Chainage");
                values.put(MediaStore.Images.Media.IS_PENDING, 1);

                Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (uri == null) return null;
                try (OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) return null;
                    bmp.compress(Bitmap.CompressFormat.JPEG, 92, out);
                }
                values.clear();
                values.put(MediaStore.Images.Media.IS_PENDING, 0);
                resolver.update(uri, values, null, null);
                return uri;
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "KEE Chainage");
                if (!dir.exists() && !dir.mkdirs()) {
                    dir = getExternalFilesDir(Environment.DIRECTORY_PICTURES);
                }
                if (dir == null) return null;
                File outFile = new File(dir, fileName);
                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    bmp.compress(Bitmap.CompressFormat.JPEG, 92, fos);
                }
                MediaScannerConnection.scanFile(this, new String[]{outFile.getAbsolutePath()}, new String[]{"image/jpeg"}, null);
                return FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", outFile);
            }
        } catch (Exception e) {
            return null;
        }
    }

    private void notifyPhotoSaved(final String stampText, final String fileName) {
        final String js = "window.onPhotoSaved && window.onPhotoSaved('" + escapeJs(stampText) + "', '" + escapeJs(fileName) + "');";
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView != null) webView.evaluateJavascript(js, null);
            }
        });
    }

    private void notifyPhotoError(final String msg) {
        final String js = "window.onPhotoError && window.onPhotoError('" + escapeJs(msg) + "');";
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView != null) webView.evaluateJavascript(js, null);
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
        public void capturePhoto(final String stampText, final String codeBadge, final String accentHex) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    pendingStampText = (stampText != null && !stampText.isEmpty()) ? stampText : "Km0+000";
                    pendingCodeBadge = codeBadge != null ? codeBadge : "";
                    pendingAccentHex = (accentHex != null && !accentHex.isEmpty()) ? accentHex : "#F59E0B";
                    launchNativeCamera(false);
                }
            });
        }

        @JavascriptInterface
        public void shareLastPhoto() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (lastSavedPhotoUri == null) return;
                    try {
                        Intent share = new Intent(Intent.ACTION_SEND);
                        share.setType(lastSavedMime);
                        share.putExtra(Intent.EXTRA_STREAM, lastSavedPhotoUri);
                        share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(Intent.createChooser(share, "Share Site Photo"));
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
