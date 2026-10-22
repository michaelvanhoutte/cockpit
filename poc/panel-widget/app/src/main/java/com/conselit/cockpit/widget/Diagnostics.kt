package com.conselit.cockpit.widget

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import androidx.work.WorkManager
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Build 3 asks why the background refresh stopped. Every process start is logged, since a
 * process Samsung killed starts again only when something wakes it, and the refresh is
 * re-scheduled there in case the kill cancelled it.
 */
class PocApp : Application() {
    override fun onCreate() {
        super.onCreate()
        logEvent(this, "app process started")
        if (PanelWidgetProvider.ids(this).isNotEmpty()) {
            PanelWidgetProvider.schedule(this)
            AlarmRefresh.arm(this)
        }
    }
}

/** A second way to refresh, an inexact alarm every 30 minutes, logged as "alarm" beside WorkManager's "background". */
object AlarmRefresh {
    private const val EVERY_MS = 30 * 60 * 1000L

    private fun intent(context: Context) = PendingIntent.getBroadcast(
        context, 3, Intent(context, AlarmReceiver::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    fun arm(context: Context) {
        val alarms = context.getSystemService(AlarmManager::class.java)
        alarms.setAndAllowWhileIdle(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            SystemClock.elapsedRealtime() + EVERY_MS,
            intent(context),
        )
    }

    fun cancel(context: Context) = context.getSystemService(AlarmManager::class.java).cancel(intent(context))
}

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AlarmRefresh.arm(context)
        val pending = goAsync()
        Thread {
            try {
                refreshOnce(context, "alarm")
            } finally {
                pending.finish()
            }
        }.start()
    }
}

/** What Android says about this app right now, for the log screen. Blocks: call off the main thread. */
fun diagnostics(context: Context): String = buildString {
    val time = SimpleDateFormat("EEE d MMM HH:mm", Locale.getDefault())
    val power = context.getSystemService(PowerManager::class.java)
    appendLine("Now: ${time.format(Date())}")
    val works = WorkManager.getInstance(context)
        .getWorkInfosForUniqueWork(PanelWidgetProvider.PERIODIC).get()
    if (works.isEmpty()) appendLine("Background refresh: NOT SCHEDULED")
    works.forEach {
        val next = it.nextScheduleTimeMillis
        appendLine(
            "Background refresh: ${it.state}, next " +
                (if (next == Long.MAX_VALUE) "unknown" else time.format(Date(next))),
        )
    }
    if (Build.VERSION.SDK_INT >= 28) {
        val bucket = when (val b = context.getSystemService(UsageStatsManager::class.java).appStandbyBucket) {
            UsageStatsManager.STANDBY_BUCKET_ACTIVE -> "active"
            UsageStatsManager.STANDBY_BUCKET_WORKING_SET -> "working set"
            UsageStatsManager.STANDBY_BUCKET_FREQUENT -> "frequent"
            UsageStatsManager.STANDBY_BUCKET_RARE -> "rare"
            45 -> "restricted"
            else -> "other ($b)"
        }
        appendLine("Standby group: $bucket")
        val restricted = context.getSystemService(ActivityManager::class.java).isBackgroundRestricted
        appendLine("Background restricted: $restricted")
    }
    appendLine("Battery optimisation ignored: ${power.isIgnoringBatteryOptimizations(context.packageName)}")
    appendLine("Power saving on: ${power.isPowerSaveMode}")
}
