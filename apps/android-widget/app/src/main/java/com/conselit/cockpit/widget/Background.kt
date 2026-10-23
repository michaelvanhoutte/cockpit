package com.conselit.cockpit.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Keeping the list fresh while the app is not open: Android's background
 * scheduler every 30 minutes, and an inexact alarm every 30 minutes behind it.
 *
 * **Both, though they look redundant.** The scheduler alone stalled for nine hours
 * on one phone for a cause nobody found, and the alarm is what fires when a
 * refresh is late. Each is set again at every process start, and the alarm at
 * each firing, so a kill that cancelled either is mended the next time anything
 * wakes the app.
 */
class Background(private val context: Context, private val graph: Graph) {

    /** The 30-minute work and the alarm. A pending one is kept, never restarted. */
    fun schedule() {
        val request = PeriodicWorkRequestBuilder<RefreshWorker>(EVERY_MINUTES, TimeUnit.MINUTES).build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        armAlarm()
    }

    /** One refresh now, in place of one already waiting. */
    fun refreshNow() {
        WorkManager.getInstance(context)
            .enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<RefreshWorker>().build())
    }

    /** The last widget is gone: nothing left to keep fresh. */
    fun cancel() {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
        context.getSystemService(AlarmManager::class.java).cancel(alarmIntent())
    }

    fun armAlarm() {
        context.getSystemService(AlarmManager::class.java).setAndAllowWhileIdle(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            SystemClock.elapsedRealtime() + TimeUnit.MINUTES.toMillis(EVERY_MINUTES),
            alarmIntent(),
        )
    }

    private fun alarmIntent(): PendingIntent = PendingIntent.getBroadcast(
        context,
        ALARM_REQUEST,
        Intent(context, AlarmReceiver::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    companion object {
        const val PERIODIC = "panel-refresh"
        const val NOW = "panel-refresh-now"
        const val EVERY_MINUTES = 30L
        private const val ALARM_REQUEST = 3
    }
}

/** The scheduler's refresh, and the one ↻ asks for. */
class RefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        applicationContext.graph.refresher.run()
        return Result.success()
    }
}

/** The alarm: sets itself again first, so a refresh that hangs does not lose the next one, then refreshes. */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val graph = context.graph
        graph.background.armAlarm()
        val pending = goAsync()
        graph.io.execute {
            try {
                graph.refresher.run()
            } finally {
                pending?.finish()
            }
        }
    }
}
