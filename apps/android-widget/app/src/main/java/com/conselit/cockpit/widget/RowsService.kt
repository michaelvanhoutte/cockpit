package com.conselit.cockpit.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import android.widget.RemoteViewsService

/** Feeds one widget's list: the lines of the Panel it last read, in the Panel's own order and groups. */
class RowsService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        RowsFactory(applicationContext, intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID))
}

class RowsFactory(private val context: Context, private val widgetId: Int) : RemoteViewsService.RemoteViewsFactory {
    private var lines: List<Line> = emptyList()

    override fun onCreate() {}
    override fun onDestroy() {}

    override fun onDataSetChanged() {
        lines = linesFor(context.graph, widgetId)
    }

    override fun getCount() = lines.size
    override fun getViewTypeCount() = 2
    override fun hasStableIds() = false
    override fun getItemId(position: Int) = position.toLong()
    override fun getLoadingView(): RemoteViews? = null

    /** What the list holds, for a test to read; a row's tap address is on it. */
    fun lines(): List<Line> = lines

    /** A position past the end happens when the list shrinks between the count and the draw; it draws as an empty heading. */
    override fun getViewAt(position: Int): RemoteViews = when (val line = lines.getOrNull(position)) {
        is Line.Item -> context.graph.renderer.rowViews(line)
        is Line.Heading -> context.graph.renderer.headingViews(line)
        null -> context.graph.renderer.headingViews(Line.Heading(""))
    }
}
