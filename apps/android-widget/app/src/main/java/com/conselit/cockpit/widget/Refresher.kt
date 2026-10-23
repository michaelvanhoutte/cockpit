package com.conselit.cockpit.widget

import android.content.Context
import java.time.LocalDate
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * One refresh of every widget on the phone, whoever asks: the scheduler, the
 * alarm, ↻, the first placing, a sign-in.
 *
 * **Asked twice at once, it reads once.** A call that arrives while a refresh is
 * running waits for it, and if that refresh began after the call was made it
 * answered the call too; only a call made after the running one began runs
 * another. Either way every call ends by drawing, so the *Refreshing…* that ↻
 * put up never outlives the refresh it announced.
 */
class Refresher(private val context: Context, private val graph: Graph) {
    private val lock = ReentrantLock()
    private val asked = AtomicLong()
    private var answered = 0L

    fun run() {
        val ticket = asked.incrementAndGet()
        try {
            lock.withLock {
                if (answered < ticket) {
                    val covers = asked.get()
                    try {
                        readEveryPanel()
                    } finally {
                        answered = covers
                    }
                }
            }
        } finally {
            // Even a read that threw: the *Refreshing…* ↻ put up is never left showing.
            graph.renderer.drawAll(refreshing = false)
        }
    }

    private fun readEveryPanel() {
        if (!graph.session.isSignedIn()) {
            // A sign-in lost anywhere else (an unreadable one, a refusal met by the picker) takes the lists with it.
            graph.widgets.wipeKept()
            return
        }
        val widgets = graph.renderer.liveWidgetIds()
        val today = LocalDate.now(graph.clock)
        // One read per Panel, however many widgets show it.
        val byPanel = widgets.asList().mapNotNull { id -> graph.widgets.binding(id)?.let { id to it } }
            .groupBy({ it.second.panelId }, { it.first })
        for ((panelId, ids) in byPanel) {
            when (val read = graph.client.panelRead(panelId, today)) {
                is Read.Data -> ids.forEach { id ->
                    graph.widgets.keep(
                        id,
                        Kept(
                            header = Header(read.value.panel.name, read.value.workspace.color),
                            read = read.value,
                            updatedAtMs = graph.clock.millis(),
                        ),
                    )
                }
                Read.NotFound -> ids.forEach { id -> graph.widgets.keep(id, problemOf(id, Problem.PANEL_DELETED)) }
                Read.NeedsNewerVersion -> ids.forEach { id -> graph.widgets.keep(id, problemOf(id, Problem.NEEDS_NEWER_VERSION)) }
                // Neither got through: the last list stays, and says so.
                Read.Offline, Read.ServerError -> ids.forEach { id ->
                    graph.widgets.kept(id)?.let { graph.widgets.keep(id, it.copy(offline = true)) }
                        ?: graph.widgets.keep(id, Kept(header = Header("Cockpit", ""), offline = true))
                }
                Read.SignedOut -> {
                    // Nothing of the person's Panels stays on the phone.
                    graph.widgets.wipeKept()
                    return
                }
            }
        }
    }

    /** The widget's heading is kept while its list is dropped: a Panel that is gone, or a list this version cannot read, has none to show. */
    private fun problemOf(widgetId: Int, problem: Problem): Kept {
        val before = graph.widgets.kept(widgetId)
        return Kept(header = before?.header ?: Header("Cockpit", ""), problem = problem)
    }
}
