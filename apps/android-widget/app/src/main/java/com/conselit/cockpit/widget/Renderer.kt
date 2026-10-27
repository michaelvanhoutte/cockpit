package com.conselit.cockpit.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import android.view.View
import android.widget.RemoteViews
import java.time.Instant
import java.time.LocalDate

/** The release page, which an out-of-date widget sends the person to. */
const val RELEASES_PAGE = "https://github.com/michaelvanhoutte/cockpit/releases"

/**
 * Draws every widget: the heading, the one line under it, and either the list or the
 * one line that says why there is no list.
 *
 * **Colours and wording that follow the phone's theme are resources, resolved when
 * the home screen inflates the views**, never numbers chosen here: a widget drawn in
 * the evening and left alone through a change to light would otherwise keep the
 * evening's colours. What is data (the Workspace's dot) is set here.
 */
class Renderer(private val context: Context, private val graph: Graph) {
    private val manager: AppWidgetManager get() = AppWidgetManager.getInstance(context)

    fun liveWidgetIds(): IntArray =
        manager.getAppWidgetIds(ComponentName(context, PanelWidgetProvider::class.java))

    fun drawAll(refreshing: Boolean) {
        val ids = liveWidgetIds()
        draw(ids, refreshing)
        manager.notifyAppWidgetViewDataChanged(ids, R.id.rows)
    }

    /** Never throws: a widget that fails to draw keeps what it showed, and the reason goes to the log. */
    fun draw(ids: IntArray, refreshing: Boolean) {
        for (id in ids) {
            try {
                manager.updateAppWidget(id, viewsFor(id, refreshing))
            } catch (e: Exception) {
                Log.e(TAG, "Could not draw widget $id", e)
            }
        }
    }

    private sealed interface Say {
        data object SignedOut : Say
        data object PickAPanel : Say
        data object Deleted : Say
        data object NeedsNewerVersion : Say
        data class Empty(val kind: String) : Say
    }

    fun viewsFor(id: Int, refreshing: Boolean): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget)
        val binding = graph.widgets.binding(id)
        val kept = graph.widgets.kept(id)
        val say: Say? = when {
            !graph.session.isSignedIn() -> Say.SignedOut
            binding == null -> Say.PickAPanel
            kept?.problem == Problem.PANEL_DELETED -> Say.Deleted
            kept?.problem == Problem.NEEDS_NEWER_VERSION -> Say.NeedsNewerVersion
            kept?.read != null && kept.read.count == 0 -> Say.Empty(binding.kind)
            else -> null
        }
        val showsHeading = say != Say.SignedOut && say != Say.PickAPanel && kept != null

        if (showsHeading) {
            val header = kept!!.header
            views.setTextViewText(R.id.panel_name, header.panelName)
            if (header.workspaceColor.isBlank()) {
                views.setViewVisibility(R.id.dot, View.GONE)
            } else {
                views.setViewVisibility(R.id.dot, View.VISIBLE)
                views.setInt(R.id.dot, "setColorFilter", colorOf(header.workspaceColor))
            }
            val count = kept.read?.count
            views.setViewVisibility(R.id.count, if (count == null) View.GONE else View.VISIBLE)
            if (count != null) views.setTextViewText(R.id.count, count.toString())
            views.setViewVisibility(R.id.updated, View.VISIBLE)
            views.setTextViewText(
                R.id.updated,
                updatedLine(kept.updatedAtMs?.let(Instant::ofEpochMilli), kept.offline, refreshing, graph.clock.zone),
            )
            views.setViewVisibility(R.id.refresh, View.VISIBLE)
            views.setViewVisibility(R.id.add, View.VISIBLE)
            views.setOnClickPendingIntent(R.id.refresh, refreshIntent(id))
            views.setOnClickPendingIntent(R.id.add, captureIntent(id, binding!!))
        } else {
            views.setTextViewText(R.id.panel_name, "Cockpit")
            for (hidden in intArrayOf(R.id.dot, R.id.count, R.id.updated, R.id.refresh, R.id.add)) {
                views.setViewVisibility(hidden, View.GONE)
            }
        }

        if (say == null) {
            views.setViewVisibility(R.id.message, View.GONE)
            views.setViewVisibility(R.id.rows, View.VISIBLE)
            val service = Intent(context, RowsService::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
            // The address makes each widget's list its own: the same intent would be handed the same adapter.
            service.data = Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME))
            views.setRemoteAdapter(R.id.rows, service)
            views.setPendingIntentTemplate(R.id.rows, itemTemplate(id))
        } else {
            views.setViewVisibility(R.id.rows, View.GONE)
            views.setViewVisibility(R.id.message, View.VISIBLE)
            views.setTextViewText(
                R.id.message,
                when (say) {
                    Say.SignedOut -> Words.SIGNED_OUT
                    Say.PickAPanel -> Words.PICK_A_PANEL
                    Say.Deleted -> Words.PANEL_DELETED
                    Say.NeedsNewerVersion -> Words.NEEDS_NEWER_VERSION
                    is Say.Empty -> emptyLine(say.kind)
                },
            )
            tapOnMessage(views, id, say)
        }
        return views
    }

    /** What a tap on the one line does: sign in, pick another Panel, or open the release page. Nothing for an empty Panel. */
    private fun tapOnMessage(views: RemoteViews, id: Int, say: Say) {
        val open = when (say) {
            Say.SignedOut -> Intent(context, MainActivity::class.java).setAction(MainActivity.ACTION_SIGN_IN)
            Say.PickAPanel, Say.Deleted -> pickerIntent(id)
            Say.NeedsNewerVersion -> Intent(Intent.ACTION_VIEW, Uri.parse(RELEASES_PAGE))
            is Say.Empty -> null
        }
        if (open == null) {
            views.setOnClickPendingIntent(R.id.message, null)
            return
        }
        val pending = if (say == Say.NeedsNewerVersion) {
            PendingIntent.getActivity(context, requestCode(id, 4), open, IMMUTABLE_UPDATE)
        } else {
            PendingIntent.getActivity(context, requestCode(id, 3), open, IMMUTABLE_UPDATE)
        }
        views.setOnClickPendingIntent(R.id.message, pending)
    }

    private fun pickerIntent(id: Int) = Intent(context, PickerActivity::class.java)
        .setAction(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE)
        .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)

    private fun refreshIntent(id: Int): PendingIntent = PendingIntent.getBroadcast(
        context,
        requestCode(id, 1),
        Intent(context, PanelWidgetProvider::class.java).setAction(PanelWidgetProvider.ACTION_REFRESH),
        IMMUTABLE_UPDATE,
    )

    private fun captureIntent(id: Int, binding: Binding): PendingIntent = PendingIntent.getActivity(
        context,
        requestCode(id, 2),
        Intent(Intent.ACTION_VIEW, Uri.parse(captureAddress(graph.origin, binding.workspaceId, binding.panelId, binding.kind))),
        IMMUTABLE_UPDATE,
    )

    /**
     * What a row's tap starts, its address filled in per row. The template is mutable
     * because each row fills in its own address, and Android 14 refuses a mutable
     * intent with no component unless it is told that is meant.
     */
    private fun itemTemplate(id: Int): PendingIntent {
        val unsafe = if (Build.VERSION.SDK_INT >= 34) PendingIntent.FLAG_ALLOW_UNSAFE_IMPLICIT_INTENT else 0
        return PendingIntent.getActivity(
            context,
            requestCode(id, 0),
            Intent(Intent.ACTION_VIEW),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE or unsafe,
        )
    }

    /** One row of the list, drawn: the flag, the title, and under it the due pill and the places. */
    fun rowViews(line: Line.Item): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.row)
        views.setContentDescription(
            R.id.flag,
            when (line.flag) {
                Flag.HIGH -> context.getString(R.string.priority_high)
                Flag.NORMAL -> context.getString(R.string.priority_normal)
                Flag.LOW -> context.getString(R.string.priority_low)
                Flag.NONE -> null
            },
        )
        views.setImageViewResource(
            R.id.flag,
            when (line.flag) {
                Flag.HIGH -> R.drawable.flag_high
                Flag.NORMAL -> R.drawable.flag_normal
                Flag.LOW -> R.drawable.flag_low
                Flag.NONE -> R.drawable.flag_unset
            },
        )
        views.setTextViewText(R.id.title, line.label)

        // One view per look, each with its colours in its own layout, so the pill follows the phone's theme.
        val pillViews = mapOf(
            PillLook.OVERDUE to R.id.pill_overdue,
            PillLook.TODAY to R.id.pill_today,
            PillLook.NEAR to R.id.pill_near,
            PillLook.WEEK to R.id.pill_week,
            PillLook.PLAIN to R.id.pill_plain,
        )
        for ((look, viewId) in pillViews) {
            val shown = line.pill?.look == look
            views.setViewVisibility(viewId, if (shown) View.VISIBLE else View.GONE)
            if (shown) views.setTextViewText(viewId, line.pill!!.text)
        }
        views.setTextViewText(R.id.place, line.place)
        views.setViewVisibility(R.id.place, if (line.place.isEmpty()) View.GONE else View.VISIBLE)
        views.setViewVisibility(R.id.second, if (line.pill == null && line.place.isEmpty()) View.GONE else View.VISIBLE)

        views.setOnClickFillInIntent(R.id.row, Intent().setData(Uri.parse(line.address)))
        return views
    }

    fun headingViews(line: Line.Heading): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.heading)
        views.setTextViewText(R.id.heading, line.text)
        return views
    }

    private fun requestCode(widgetId: Int, purpose: Int) = widgetId * 10 + purpose

    private companion object {
        const val TAG = "CockpitWidget"
        const val IMMUTABLE_UPDATE = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    }
}

/** The lines of the list a widget scrolls, from what it last read, today being the phone's own day. */
fun linesFor(graph: Graph, widgetId: Int): List<Line> {
    val read = graph.widgets.kept(widgetId)?.read ?: return emptyList()
    return linesOf(read, graph.origin, LocalDate.now(graph.clock))
}
