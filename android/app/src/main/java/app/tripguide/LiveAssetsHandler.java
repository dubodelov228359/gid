package app.tripguide;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.WebResourceResponse;

import androidx.webkit.WebViewAssetLoader;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Файлы приложения с сайта, без переустановки APK.
 *
 * При запуске (запрос index.html) сверяем version.json на сайте с сохранённым. Вышла новая
 * версия — в этот запуск каждый файл скачиваем заново и сохраняем; иначе отдаём сохранённую копию.
 * Нет сети и копии — берём файлы, зашитые в APK. Адрес внутри приложения не меняется,
 * поэтому поездки, отметки и офлайн-карты остаются на месте.
 */
class LiveAssetsHandler implements WebViewAssetLoader.PathHandler {
    static final String SITE = "https://dubodelov228359.github.io/gid/";

    private final File dir;
    private final SharedPreferences prefs;
    private final WebViewAssetLoader.AssetsPathHandler bundled;
    private volatile boolean refreshing;
    private volatile String pendingVersion;

    LiveAssetsHandler(Context ctx) {
        dir = new File(ctx.getFilesDir(), "live");
        prefs = ctx.getSharedPreferences("live", Context.MODE_PRIVATE);
        bundled = new WebViewAssetLoader.AssetsPathHandler(ctx);
    }

    @Override
    public WebResourceResponse handle(String path) {
        if (path.isEmpty()) path = "index.html";
        if (path.equals("index.html")) checkVersion();

        File saved = new File(dir, path);
        if (refreshing) {
            byte[] fresh = download(SITE + path);
            if (fresh != null) {
                save(saved, fresh);
                if (path.equals("index.html") && pendingVersion != null) {
                    prefs.edit().putString("version", pendingVersion).apply();
                }
                return response(path, new java.io.ByteArrayInputStream(fresh));
            }
        }
        if (saved.isFile()) {
            try {
                return response(path, new FileInputStream(saved));
            } catch (IOException ignored) {
                // Повреждённый файл — возьмём зашитый в APK.
            }
        }
        return bundled.handle(path);
    }

    private void checkVersion() {
        refreshing = false;
        byte[] v = download(SITE + "version.json?t=" + System.currentTimeMillis());
        if (v == null) return; // нет сети — работаем с тем, что есть
        String remote = new String(v).trim();
        if (!remote.equals(prefs.getString("version", ""))) {
            pendingVersion = remote;
            refreshing = true;
        }
    }

    private static byte[] download(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(4000);
            c.setReadTimeout(15000);
            c.setUseCaches(false);
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toByteArray();
            }
        } catch (IOException e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static void save(File f, byte[] data) {
        try {
            File parent = f.getParentFile();
            if (parent != null) parent.mkdirs();
            File tmp = new File(f.getPath() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(tmp)) {
                out.write(data);
            }
            if (!tmp.renameTo(f)) tmp.delete();
        } catch (IOException ignored) {
            // Не сохранилось — в следующий раз скачаем снова.
        }
    }

    private static WebResourceResponse response(String path, InputStream body) {
        return new WebResourceResponse(mime(path), null, body);
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json") || path.endsWith(".webmanifest")) return "application/json";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }
}
