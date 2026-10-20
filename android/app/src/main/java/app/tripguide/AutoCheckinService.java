package app.tripguide;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * Автоотметка: следит за GPS, пока включена, и если ты задержался у места
 * (ближе 50 м дольше полутора минут) — отмечает его и присылает уведомление.
 * Отметки копятся в SharedPreferences, приложение забирает их при открытии.
 */
public class AutoCheckinService extends Service implements LocationListener {
    static final String PREFS = "autocheckin";
    static final String ACTION_STOP = "app.tripguide.STOP_AUTOCHECKIN";
    private static final String CHANNEL_STATUS = "autocheckin";
    private static final String CHANNEL_VISITS = "visits";
    private static final double RADIUS_M = 50;
    private static final long DWELL_MS = 90_000;

    private LocationManager lm;
    private final Map<String, Long> nearSince = new HashMap<>();

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, AutoCheckinService.class);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
    }

    public static void stop(Context ctx) {
        ctx.stopService(new Intent(ctx, AutoCheckinService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            prefs(this).edit().putBoolean("enabled", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_STATUS, "Автоотметка (фон)", NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel(CHANNEL_VISITS, "Отмеченные места", NotificationManager.IMPORTANCE_DEFAULT));

        PendingIntent stopPi = PendingIntent.getService(this, 1,
                new Intent(this, AutoCheckinService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification status = new Notification.Builder(this, CHANNEL_STATUS)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("Гид отмечает места")
                .setContentText("Постой у достопримечательности минуту — отмечу сам")
                .setContentIntent(openApp(this))
                .addAction(new Notification.Action.Builder(null, "Выключить", stopPi).build())
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, status, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        else startForeground(1, status);

        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED
                && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (lm == null) {
            lm = getSystemService(LocationManager.class);
            try {
                if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER))
                    lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 15_000, 10, this, Looper.getMainLooper());
                if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
                    lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 30_000, 20, this, Looper.getMainLooper());
            } catch (SecurityException e) {
                stopSelf();
            }
        }
        return START_STICKY;
    }

    @Override
    public void onLocationChanged(Location loc) {
        if (loc.hasAccuracy() && loc.getAccuracy() > 60) return; // слишком неточно — не гадаем
        SharedPreferences p = prefs(this);
        try {
            JSONArray places = new JSONArray(p.getString("places", "[]"));
            JSONArray visits = new JSONArray(p.getString("visits", "[]"));
            JSONArray remaining = new JSONArray();
            long now = System.currentTimeMillis();
            boolean changed = false;
            float[] d = new float[1];
            for (int i = 0; i < places.length(); i++) {
                JSONObject pl = places.getJSONObject(i);
                String id = pl.getString("id");
                Location.distanceBetween(loc.getLatitude(), loc.getLongitude(), pl.getDouble("lat"), pl.getDouble("lon"), d);
                if (d[0] <= RADIUS_M) {
                    Long since = nearSince.get(id);
                    if (since == null) nearSince.put(id, now);
                    else if (now - since >= DWELL_MS) {
                        visits.put(new JSONObject().put("id", id).put("name", pl.getString("name")).put("time", now));
                        notifyVisit(pl.getString("name"), id.hashCode());
                        nearSince.remove(id);
                        changed = true;
                        continue; // больше не следим за этим местом
                    }
                } else {
                    nearSince.remove(id);
                }
                remaining.put(pl);
            }
            if (changed) p.edit().putString("places", remaining.toString()).putString("visits", visits.toString()).apply();
        } catch (Exception ignored) {
            // Повреждённые данные — пропускаем эту точку.
        }
    }

    private void notifyVisit(String name, int id) {
        Notification n = new Notification.Builder(this, CHANNEL_VISITS)
                .setSmallIcon(android.R.drawable.checkbox_on_background)
                .setContentTitle("✓ Отмечено: " + name)
                .setContentText("Ошибка? Открой приложение и сними отметку.")
                .setContentIntent(openApp(this))
                .setAutoCancel(true)
                .build();
        getSystemService(NotificationManager.class).notify(1000 + (id & 0xffff), n);
    }

    static PendingIntent openApp(Context ctx) {
        return PendingIntent.getActivity(ctx, 0,
                new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE);
    }

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    @Override
    public void onDestroy() {
        if (lm != null) lm.removeUpdates(this);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // Старые версии Android требуют эти методы у LocationListener.
    @Override public void onProviderEnabled(String provider) {}
    @Override public void onProviderDisabled(String provider) {}
    @Override public void onStatusChanged(String provider, int status, android.os.Bundle extras) {}
}
