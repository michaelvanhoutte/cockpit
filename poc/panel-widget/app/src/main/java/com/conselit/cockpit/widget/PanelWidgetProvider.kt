package com.conselit.cockpit.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

class PanelWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        schedule(context)
        render(context, manager, ids, refreshing = false)
    }

    override fun onEnabled(context: Context) {
        schedule(context)
        refreshNow(context, "first placed")
    }

    override fun onDisabled(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) {
            val manager = AppWidgetManager.getInstance(context)
            render(context, manager, ids(context), refreshing = true)
            refreshNow(context, "button")
        }
    }

    companion object {
        private const val ACTION_REFRESH = "com.conselit.cockpit.widget.REFRESH"
        private const val PERIODIC = "panel-refresh"

        private fun ids(context: Context): IntArray =
            AppWidgetManager.getInstance(context)
                .getAppWidgetIds(ComponentName(context, PanelWidgetProvider::class.java))

        private fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<RefreshWorker>(30, TimeUnit.MINUTES)
                .setInputData(workDataOf("source" to "background"))
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        private fun refreshNow(context: Context, source: String) {
            val request = OneTimeWorkRequestBuilder<RefreshWorker>()
                .setInputData(workDataOf("source" to source))
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork("panel-refresh-now", ExistingWorkPolicy.REPLACE, request)
        }

        fun renderAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = ids(context)
            render(context, manager, ids, refreshing = false)
            manager.notifyAppWidgetViewDataChanged(ids, R.id.rows)
        }

        private fun render(context: Context, manager: AppWidgetManager, ids: IntArray, refreshing: Boolean) {
            val last = RefreshLog.all(context).lastOrNull()
            val updated = when {
                refreshing -> "Refreshing…"
                last == null -> "Not refreshed yet"
                else -> "Updated " + SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(last.at)) +
                    if (last.ok) "" else " · offline, showing the last list"
            }
            for (id in ids) {
                val views = RemoteViews(context.packageName, R.layout.widget)
                views.setTextViewText(R.id.panel_name, "Due this week  ${SampleRows.items.size}")
                views.setTextViewText(R.id.updated, updated)

                val service = Intent(context, RowsService::class.java)
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                service.data = Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME))
                views.setRemoteAdapter(R.id.rows, service)

                val open = PendingIntent.getActivity(
                    context, 0, Intent(Intent.ACTION_VIEW),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                views.setPendingIntentTemplate(R.id.rows, open)

                val refresh = PendingIntent.getBroadcast(
                    context, 1,
                    Intent(context, PanelWidgetProvider::class.java).setAction(ACTION_REFRESH),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                views.setOnClickPendingIntent(R.id.refresh, refresh)

                val capture = PendingIntent.getActivity(
                    context, 2, Intent(Intent.ACTION_VIEW, Uri.parse("$ORIGIN/capture")),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                views.setOnClickPendingIntent(R.id.add, capture)

                manager.updateAppWidget(id, views)
            }
        }
    }
}
