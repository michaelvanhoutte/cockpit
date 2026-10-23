package com.conselit.cockpit.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import org.robolectric.Shadows.shadowOf
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.concurrent.Executor

/** Same app as the real one, with nothing started at launch: each test builds the phone it needs. */
class TestApp : CockpitApp() {
    override fun onCreate() {
        // The phone is built by `Phone`, around a fake Cockpit.
    }
}

/** A clock a test moves. */
class TestClock(private var now: Instant, private val zone: ZoneId = ZoneOffset.UTC) : Clock() {
    override fun getZone(): ZoneId = zone
    override fun withZone(zone: ZoneId): Clock = TestClock(now, zone)
    override fun instant(): Instant = now
    fun advance(by: Duration) {
        now = now.plus(by)
    }
}

/**
 * A phone running the app against a fake Cockpit: the real graph, with the origin,
 * the clock and the secret box replaced, and background work run where it is asked.
 */
/** Work the scheduler hands over, held until a test lets it run. */
class ManualExecutor : Executor {
    private val queue = ArrayDeque<Runnable>()
    override fun execute(command: Runnable) {
        queue.addLast(command)
    }

    fun runAll() {
        while (queue.isNotEmpty()) queue.removeFirst().run()
    }
}

class Phone(val cockpit: FakeCockpit, workExecutor: Executor = SynchronousExecutor()) {
    val context: Context = ApplicationProvider.getApplicationContext()
    val clock = TestClock(Instant.parse("2026-10-23T11:05:00Z"))
    val app = context as TestApp
    val graph: Graph
    private val manager: AppWidgetManager = AppWidgetManager.getInstance(context)

    init {
        WorkManagerTestInitHelper.initializeTestWorkManager(
            context,
            Configuration.Builder().setExecutor(workExecutor).build(),
        )
        graph = Graph(
            context,
            origin = cockpit.origin,
            redirectUri = "cockpit-widget://oauth",
            clock = clock,
            secretBox = object : SecretBox {
                override fun seal(plain: String) = "sealed:$plain"
                override fun open(sealed: String) = sealed.removePrefix("sealed:").takeIf { sealed.startsWith("sealed:") }
            },
            io = Executor { it.run() },
        )
        app.graph = graph
    }

    /** Signed in as the app is after the browser has brought a code home. */
    fun signedIn(): Phone {
        val (access, refresh) = cockpit.issueSignIn()
        graph.session.saveClientId("client-1")
        graph.session.save(Session(access, refresh, clock.millis() + Duration.ofHours(1).toMillis()))
        return this
    }

    /** What the home screen does for a widget placed on it: bind, announce the first one, and update. */
    fun placeWidget(panel: PanelEntry? = null, workspace: WorkspaceEntry? = null): Int {
        val id = shadowOf(manager).createWidget(PanelWidgetProvider::class.java, R.layout.widget)
        val first = liveWidgetIds().size == 1
        if (panel != null) {
            graph.widgets.bind(id, Binding(panel.id, panel.kind, workspace!!.id))
            graph.widgets.keep(id, Kept(header = Header(panel.name, workspace.color)))
        }
        val provider = PanelWidgetProvider()
        if (first) provider.onReceive(context, Intent(AppWidgetManager.ACTION_APPWIDGET_ENABLED))
        provider.onReceive(
            context,
            Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE).putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, intArrayOf(id)),
        )
        return id
    }

    fun removeWidget(id: Int) {
        PanelWidgetProvider().onReceive(
            context,
            Intent(AppWidgetManager.ACTION_APPWIDGET_DELETED).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id),
        )
    }

    fun removeLastWidget() {
        PanelWidgetProvider().onReceive(context, Intent(AppWidgetManager.ACTION_APPWIDGET_DISABLED))
    }

    fun liveWidgetIds(): List<Int> = graph.renderer.liveWidgetIds().toList()

    /** The widget as the home screen holds it: what was last drawn onto it. */
    fun widget(id: Int): View = shadowOf(manager).getViewFor(id)

    /** The list a widget scrolls, each line as the views a person would see. */
    fun rows(id: Int): List<View> {
        val factory = RowsFactory(context, id)
        factory.onDataSetChanged()
        return (0 until factory.count).map { factory.getViewAt(it).apply(context, FrameLayout(context)) }
    }

    fun rowFactory(id: Int) = RowsFactory(context, id).also { it.onDataSetChanged() }

    fun text(view: View, id: Int): String = view.findViewById<TextView>(id).text.toString()

    fun isShown(view: View, id: Int) = view.findViewById<View>(id).visibility == View.VISIBLE

    /** One refresh of everything, as the scheduler, the alarm, ↻ and a sign-in all run it. */
    fun refresh() = graph.refresher.run()
}