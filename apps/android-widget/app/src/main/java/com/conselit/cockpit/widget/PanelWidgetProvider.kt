package com.conselit.cockpit.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent

/** The widget itself: a Panel on the home screen. Several can stand side by side, each on its own Panel. */
class PanelWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val graph = context.graph
        graph.background.schedule()
        graph.renderer.draw(ids, refreshing = false)
    }

    /** The first widget on the phone: read now, and keep reading. */
    override fun onEnabled(context: Context) {
        val graph = context.graph
        graph.background.schedule()
        graph.background.refreshNow()
    }

    override fun onDeleted(context: Context, ids: IntArray) {
        ids.forEach { context.graph.widgets.forget(it) }
    }

    /** The last widget is gone, so nothing is read, and nothing wakes the phone for it. */
    override fun onDisabled(context: Context) {
        context.graph.background.cancel()
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) {
            val graph = context.graph
            graph.renderer.drawAll(refreshing = true)
            graph.background.refreshNow()
        }
    }

    companion object {
        const val ACTION_REFRESH = "com.conselit.cockpit.widget.REFRESH"
    }
}
