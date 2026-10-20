package app.tripguide;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;

import java.util.Locale;

/**
 * Оболочка для веб-приложения из assets: WebView + геолокация, внешние ссылки,
 * напоминания о билетах и системная кнопка «назад».
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/assets/index.html";
    private static final int REQ_LOCATION = 1;
    private static final int REQ_NOTIFICATIONS = 2;
    private static final int REQ_AUTOCHECKIN = 3;

    private WebView web;
    private TextToSpeech tts;
    private boolean ttsReady;
    private volatile String lastUtterance;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private String pendingGeoOrigin;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);

        // Отдаём файлы приложения по https://appassets.androidplatform.net/assets/…:
        // так работают ES-модули, Cache Storage (офлайн-карты) и геолокация.
        // Сами файлы — свежие с сайта (см. LiveAssetsHandler), без сети — сохранённые.
        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new LiveAssetsHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                openExternal(url.toString());
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocationPermission()) {
                    callback.invoke(origin, true, false);
                } else {
                    pendingGeoOrigin = origin;
                    pendingGeoCallback = callback;
                    requestPermissions(new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
                }
            }
        });

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        // Синтез речи для «Слушать» в гиде.
        tts = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                tts.setLanguage(new Locale("ru", "RU"));
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) {}
                    @Override public void onError(String id) {}
                    @Override public void onDone(String id) {
                        // Дочитали последний кусок — сообщаем приложению, чтобы кнопка снова стала «Слушать».
                        if (id.equals(lastUtterance)) {
                            web.post(() -> web.evaluateJavascript("window.tgSpeechEnded && window.tgSpeechEnded()", null));
                        }
                    }
                });
                ttsReady = true;
            }
        });

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(START_URL);
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_AUTOCHECKIN) {
            if (hasLocationPermission()) AutoCheckinService.start(this);
            else web.evaluateJavascript("window.tgAutoCheckinDenied && window.tgAutoCheckinDenied()", null);
        }
        if (requestCode == REQ_LOCATION && pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, hasLocationPermission(), false);
            pendingGeoCallback = null;
        }
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Сначала спрашиваем приложение: закрыть окно или вернуться на прошлый экран.
        web.evaluateJavascript("window.tgBack ? window.tgBack() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    private void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
            // Нет приложения для такой ссылки — ничего не делаем.
        }
    }

    /** То, что веб-приложение может вызвать через window.AndroidBridge. */
    private class Bridge {
        @JavascriptInterface
        public void openUrl(String url) {
            runOnUiThread(() -> openExternal(url));
        }

        @JavascriptInterface
        public void speak(String paragraphsJson) {
            if (!ttsReady) return;
            try {
                JSONArray parts = new JSONArray(paragraphsJson);
                int max = TextToSpeech.getMaxSpeechInputLength() - 1;
                tts.stop();
                for (int i = 0; i < parts.length(); i++) {
                    String text = parts.getString(i);
                    // Длинные абзацы режем: у синтеза есть предел длины одной фразы.
                    for (int start = 0; start < text.length(); start += max) {
                        String chunk = text.substring(start, Math.min(text.length(), start + max));
                        String id = "p" + i + "_" + start;
                        lastUtterance = id;
                        tts.speak(chunk, TextToSpeech.QUEUE_ADD, null, id);
                    }
                }
            } catch (Exception ignored) {
                // Неверные данные — просто молчим.
            }
        }

        /** Включить автоотметку: places — JSON [{id,name,lat,lon}] непосещённых мест. */
        @JavascriptInterface
        public void startAutoCheckin(String placesJson) {
            AutoCheckinService.prefs(MainActivity.this).edit()
                    .putString("places", placesJson).putBoolean("enabled", true).apply();
            runOnUiThread(() -> {
                java.util.List<String> need = new java.util.ArrayList<>();
                if (!hasLocationPermission()) need.add(Manifest.permission.ACCESS_FINE_LOCATION);
                if (Build.VERSION.SDK_INT >= 33
                        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    need.add(Manifest.permission.POST_NOTIFICATIONS);
                }
                if (need.isEmpty()) AutoCheckinService.start(MainActivity.this);
                else requestPermissions(need.toArray(new String[0]), REQ_AUTOCHECKIN);
            });
        }

        @JavascriptInterface
        public void updateAutoCheckinPlaces(String placesJson) {
            AutoCheckinService.prefs(MainActivity.this).edit().putString("places", placesJson).apply();
        }

        @JavascriptInterface
        public void stopAutoCheckin() {
            AutoCheckinService.prefs(MainActivity.this).edit().putBoolean("enabled", false).apply();
            AutoCheckinService.stop(MainActivity.this);
        }

        @JavascriptInterface
        public boolean isAutoCheckinOn() {
            return AutoCheckinService.prefs(MainActivity.this).getBoolean("enabled", false);
        }

        /** Отметки, сделанные в фоне, — забираем и очищаем. */
        @JavascriptInterface
        public String takeVisits() {
            android.content.SharedPreferences p = AutoCheckinService.prefs(MainActivity.this);
            String visits = p.getString("visits", "[]");
            p.edit().putString("visits", "[]").apply();
            return visits;
        }

        @JavascriptInterface
        public void stopSpeaking() {
            if (tts != null) tts.stop();
        }

        @JavascriptInterface
        public boolean scheduleReminder(String id, String title, String text, double whenMillis) {
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                runOnUiThread(() -> requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS));
            }
            Context ctx = MainActivity.this;
            Intent intent = new Intent(ctx, ReminderReceiver.class)
                    .putExtra("title", title)
                    .putExtra("text", text)
                    .putExtra("id", id.hashCode());
            PendingIntent pi = PendingIntent.getBroadcast(ctx, id.hashCode(), intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            AlarmManager am = (AlarmManager) getSystemService(ALARM_SERVICE);
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, (long) whenMillis, pi);
            return true;
        }
    }
}
