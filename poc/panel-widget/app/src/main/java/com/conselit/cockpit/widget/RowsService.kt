package com.conselit.cockpit.widget

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import androidx.core.content.ContextCompat
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/** Sample rows standing in for a Filter panel, due dates relative to today so the pills move. */
data class SampleItem(val title: String, val dueInDays: Long?, val tint: Int)

object SampleRows {
    val items = listOf(
        SampleItem("Send the Q4 forecast to Sander", -2, R.color.tint_violet),
        SampleItem("Renew the Cloudflare domain", 0, R.color.tint_violet),
        SampleItem("Prepare the steering committee deck", 1, R.color.tint_teal),
        SampleItem("Book the tennis court for Friday", 2, R.color.tint_violet),
        SampleItem("Review the Hasselt proposal", 5, R.color.tint_teal),
        SampleItem("Plan the offsite agenda", 12, R.color.tint_teal),
        SampleItem("Untitled", null, R.color.tint_violet),
    )
}

class RowsService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Factory(applicationContext)
}

private class Factory(private val context: Context) : RemoteViewsService.RemoteViewsFactory {
    private var log: List<Refresh> = emptyList()

    override fun onCreate() {}
    override fun onDestroy() {}
    override fun onDataSetChanged() {
        log = RefreshLog.all(context).takeLast(30).reversed()
    }

    // The sample rows, then a heading and the refresh log, which only the POC carries.
    override fun getCount() = SampleRows.items.size + 1 + log.size
    override fun getViewTypeCount() = 2
    override fun hasStableIds() = false
    override fun getItemId(position: Int) = position.toLong()
    override fun getLoadingView(): RemoteViews? = null

    override fun getViewAt(position: Int): RemoteViews {
        val items = SampleRows.items
        if (position >= items.size) {
            val views = RemoteViews(context.packageName, R.layout.note_row)
            val text = if (position == items.size) "POC · refresh log, newest first"
            else RefreshLog.describe(log[position - items.size - 1])
            views.setTextViewText(R.id.note, text)
            return views
        }

        val item = items[position]
        val views = RemoteViews(context.packageName, R.layout.row)
        views.setTextViewText(R.id.title, item.title)
        views.setInt(R.id.bar, "setColorFilter", ContextCompat.getColor(context, item.tint))
        applyPill(views, item.dueInDays)
        views.setOnClickFillInIntent(R.id.row, Intent().setData(Uri.parse("$ORIGIN/")))
        return views
    }

    /** The phone's rule: within a week a pill under the title, further off a plain "Due <date>". */
    private fun applyPill(views: RemoteViews, days: Long?) {
        if (days == null) {
            views.setViewVisibility(R.id.pill, View.GONE)
            return
        }
        views.setViewVisibility(R.id.pill, View.VISIBLE)
        val amber = ContextCompat.getColor(context, R.color.amber)
        val white = ContextCompat.getColor(context, R.color.on_solid)
        val quiet = ContextCompat.getColor(context, R.color.ink_quiet)
        val (text, background, color) = when {
            days < 0 -> Triple("Overdue ${-days}d", R.drawable.pill_red, white)
            days == 0L -> Triple("Due today", R.drawable.pill_solid, white)
            days == 1L -> Triple("Due tomorrow", R.drawable.pill_soft, amber)
            days == 2L -> Triple("Due in 2d", R.drawable.pill_soft, amber)
            days <= 7 -> Triple("Due in ${days}d", R.drawable.pill_outline, amber)
            else -> {
                val date = LocalDate.now().plus(days, ChronoUnit.DAYS)
                Triple("Due " + date.format(DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())), 0, quiet)
            }
        }
        views.setTextViewText(R.id.pill, text)
        views.setTextColor(R.id.pill, color)
        views.setInt(R.id.pill, "setBackgroundResource", background)
    }
}
