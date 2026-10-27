package com.conselit.cockpit.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView

/** One line of the picker. */
sealed interface PickerEntry {
    data class Workspace(val name: String, val color: String) : PickerEntry
    data class Dashboard(val name: String) : PickerEntry
    data class Pick(val workspace: WorkspaceEntry, val panel: PanelEntry) : PickerEntry
}

/**
 * The Panels a widget can show, grouped by Workspace and then Dashboard, in the order
 * the server lists them (the tab order). Only Panels of items and Filter panels are
 * offered; a Dashboard or Workspace left with none is not listed at all.
 */
fun pickerEntries(list: PanelList): List<PickerEntry> = list.workspaces.flatMap { workspace ->
    val dashboards = workspace.dashboards.mapNotNull { dashboard ->
        val offered = dashboard.panels.filter { it.kind in OFFERED_KINDS }
        if (offered.isEmpty()) null else dashboard to offered
    }
    if (dashboards.isEmpty()) {
        emptyList()
    } else {
        listOf<PickerEntry>(PickerEntry.Workspace(workspace.name, workspace.color)) +
            dashboards.flatMap { (dashboard, panels) ->
                listOf<PickerEntry>(PickerEntry.Dashboard(dashboard.name)) + panels.map { PickerEntry.Pick(workspace, it) }
            }
    }
}

/**
 * Placing a widget opens this: the Panels to choose from. Several widgets can each
 * be given their own, from any Workspace. Opened from a widget whose Panel was deleted,
 * it chooses another for the same widget.
 */
class PickerActivity : Activity() {
    private val graph get() = application.graph
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID
    private lateinit var status: TextView
    private lateinit var action: Button
    private lateinit var list: ListView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        // Backing out leaves the widget unplaced.
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        if (widgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish()
            return
        }
        val pad = (16 * resources.displayMetrics.density).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        column.addView(TextView(this).apply { text = "Pick a Panel for this widget"; textSize = 22f })
        status = TextView(this).apply { setPadding(0, pad, 0, pad / 2) }
        action = Button(this)
        list = ListView(this)
        column.addView(status)
        column.addView(action)
        column.addView(list, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        column.keepClearOfSystemBars()
        setContentView(column)
    }

    override fun onResume() {
        super.onResume()
        if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) load()
    }

    private fun load() {
        list.visibility = View.GONE
        if (!graph.session.isSignedIn()) {
            say("Sign in to Cockpit to choose which Panel this widget shows.", "Sign in") {
                startActivity(
                    Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_SIGN_IN),
                )
            }
            return
        }
        say("Loading your Panels…", null) {}
        graph.io.execute {
            val read = graph.client.panelList()
            runOnUiThread { shown(read) }
        }
    }

    private fun shown(read: Read<PanelList>) {
        when (read) {
            is Read.Data -> {
                val entries = pickerEntries(read.value)
                if (entries.isEmpty()) {
                    say("Nothing to show yet: no Workspace has a Panel of items or a Filter panel.", null) {}
                } else {
                    status.visibility = View.GONE
                    action.visibility = View.GONE
                    list.visibility = View.VISIBLE
                    list.adapter = PickerAdapter(entries)
                    list.setOnItemClickListener { _, _, position, _ ->
                        (entries[position] as? PickerEntry.Pick)?.let { chosen(it) }
                    }
                }
            }
            // The sign-in ended under the picker: nothing of the person's Panels stays, and every widget says so.
            Read.SignedOut -> {
                graph.widgets.wipeKept()
                graph.renderer.drawAll(refreshing = false)
                load()
            }
            else -> say("Could not load your Panels.", "Try again") { load() }
        }
    }

    private fun say(text: String, button: String?, onClick: () -> Unit) {
        status.visibility = View.VISIBLE
        status.text = text
        if (button == null) {
            action.visibility = View.GONE
        } else {
            action.visibility = View.VISIBLE
            action.text = button
            action.setOnClickListener { onClick() }
        }
    }

    private fun chosen(pick: PickerEntry.Pick) {
        graph.widgets.bind(widgetId, Binding(pick.panel.id, pick.panel.kind, pick.workspace.id))
        graph.widgets.keep(widgetId, Kept(header = Header(pick.panel.name, pick.workspace.color)))
        // The widget shows its Panel's name at once, then the rows as they arrive.
        graph.renderer.draw(intArrayOf(widgetId), refreshing = true)
        graph.background.refreshNow()
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId))
        finish()
    }

    private inner class PickerAdapter(private val entries: List<PickerEntry>) : BaseAdapter() {
        override fun getCount() = entries.size
        override fun getItem(position: Int) = entries[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getViewTypeCount() = 1
        override fun isEnabled(position: Int) = entries[position] is PickerEntry.Pick

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val density = resources.displayMetrics.density
            val text = TextView(this@PickerActivity)
            text.gravity = Gravity.CENTER_VERTICAL
            when (val entry = entries[position]) {
                is PickerEntry.Workspace -> {
                    text.text = entry.name
                    text.textSize = 18f
                    text.setPadding(0, (18 * density).toInt(), 0, (4 * density).toInt())
                    val dot = GradientDrawable().apply {
                        shape = GradientDrawable.OVAL
                        setColor(colorOf(entry.color))
                        setSize((10 * density).toInt(), (10 * density).toInt())
                    }
                    text.setCompoundDrawablesRelativeWithIntrinsicBounds(dot, null, null, null)
                    text.compoundDrawablePadding = (8 * density).toInt()
                }
                is PickerEntry.Dashboard -> {
                    text.text = entry.name
                    text.textSize = 13f
                    text.alpha = 0.7f
                    text.setPadding((18 * density).toInt(), (8 * density).toInt(), 0, 0)
                }
                is PickerEntry.Pick -> {
                    text.text = entry.panel.name
                    text.textSize = 16f
                    text.setPadding((18 * density).toInt(), (10 * density).toInt(), 0, (10 * density).toInt())
                }
            }
            return text
        }
    }
}
