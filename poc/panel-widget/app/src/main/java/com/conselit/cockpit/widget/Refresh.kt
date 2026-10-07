package com.conselit.cockpit.widget

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

const val ORIGIN = "https://cockpit.vanhoutte-michael.workers.dev"

/** One refresh as the POC records it, so gaps in background refreshing show afterwards. */
data class Refresh(val at: Long, val source: String, val ok: Boolean)

object RefreshLog {
    private const val PREFS = "refresh-log"
    private const val KEY = "entries"
    private const val KEEP = 200

    fun all(context: Context): List<Refresh> =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY, "")!!
            .lines()
            .filter { it.isNotBlank() }
            .map { line ->
                val (at, source, ok) = line.split(",")
                Refresh(at.toLong(), source, ok == "1")
            }

    fun add(context: Context, entry: Refresh) {
        val lines = (all(context) + entry).takeLast(KEEP)
            .joinToString("\n") { "${it.at},${it.source},${if (it.ok) 1 else 0}" }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, lines).apply()
    }

    fun describe(entry: Refresh): String {
        val time = SimpleDateFormat("EEE d MMM HH:mm", Locale.getDefault()).format(Date(entry.at))
        return "$time  ${entry.source}${if (entry.ok) "" else "  (offline)"}"
    }
}

class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val source = inputData.getString("source") ?: "background"
        val ok = withContext(Dispatchers.IO) {
            try {
                val connection = URL("$ORIGIN/health").openConnection() as HttpURLConnection
                connection.connectTimeout = 10_000
                connection.readTimeout = 10_000
                try {
                    connection.responseCode == 200
                } finally {
                    connection.disconnect()
                }
            } catch (e: Exception) {
                false
            }
        }
        RefreshLog.add(applicationContext, Refresh(System.currentTimeMillis(), source, ok))
        PanelWidgetProvider.renderAll(applicationContext)
        return Result.success()
    }
}
