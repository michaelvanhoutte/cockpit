package com.conselit.cockpit.widget

import android.app.Application
import android.content.Context
import okhttp3.OkHttpClient
import java.time.Clock
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Everything the app is made of, built once per process. Each part takes what it
 * needs from here, so a test hands the app a fake Cockpit's address, a fixed
 * clock and a plain secret box in place of the real ones and runs the rest as it is.
 */
class Graph(
    context: Context,
    val origin: String = BuildConfig.ORIGIN,
    val redirectUri: String = BuildConfig.REDIRECT_URI,
    val clock: Clock = DeviceClock,
    secretBox: SecretBox = KeystoreSecretBox(),
    http: OkHttpClient = CockpitClient.defaultHttp(),
    /** Where work that must not block a receiver or a screen runs. */
    val io: Executor = Executors.newCachedThreadPool(),
) {
    val app: Context = context.applicationContext
    val session = SessionStore(app, secretBox)
    val widgets = WidgetStore(app)
    val client = CockpitClient(origin, redirectUri, session, clock, http)
    val background = Background(app, this)
    val refresher = Refresher(app, this)
    val renderer = Renderer(app, this)

    /** Signs out of this phone: the sign-in gone, and every list and name kept with it. */
    fun signOut() {
        session.clear()
        widgets.wipeKept()
    }
}

/**
 * The phone's own clock and zone, asked every time: a process can outlive the
 * traveller's change of time zone, and "today" and *Updated 11:05* are the
 * phone's, not the zone it was started in.
 */
object DeviceClock : Clock() {
    override fun getZone(): ZoneId = ZoneId.systemDefault()
    override fun withZone(zone: ZoneId): Clock = Clock.system(zone)
    override fun instant(): Instant = Instant.now()
}

open class CockpitApp : Application() {
    open lateinit var graph: Graph

    override fun onCreate() {
        super.onCreate()
        graph = Graph(this)
        onProcessStart()
    }

    /**
     * A process Android killed starts again only when something wakes it, and the
     * refresh may have been lost with it: the 30-minute work is enqueued again
     * (a pending one is kept, not restarted) and the alarm armed again.
     */
    fun onProcessStart() {
        if (graph.renderer.liveWidgetIds().isNotEmpty()) graph.background.schedule()
    }
}

val Context.graph: Graph get() = (applicationContext as CockpitApp).graph
