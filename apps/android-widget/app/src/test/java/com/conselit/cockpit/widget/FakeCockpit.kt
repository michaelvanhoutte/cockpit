package com.conselit.cockpit.widget

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.net.URLDecoder
import java.util.concurrent.CopyOnWriteArrayList

/** What the fake answers: a status, a body, and optionally headers. */
data class Answer(val status: Int, val body: String = "", val headers: Map<String, String> = emptyMap())

/**
 * Cockpit as the app meets it, at the network boundary: a server answering the
 * addresses the issue's contract names, with the sample answer files the server's
 * own tests hold its real answers to. The app does its own requests against it.
 *
 * Tokens work the way the real ones do: a sign-in issues an access token and a
 * refresh token, a refresh spends the refresh token and issues the next pair, and
 * `disconnect()` ends the grant, after which every token is refused.
 */
class FakeCockpit : AutoCloseable {
    private val server = MockWebServer()

    /** Every request the app made, in order. */
    val requests = CopyOnWriteArrayList<RecordedRequest>()

    /** What the Panel list answers. */
    @Volatile var panelList = Answer(200, Samples.panelList)

    /** What reading a Panel answers, by the Panel's id. A Panel not named here is not found. */
    val panelReads = mutableMapOf<String, Answer>()

    /** Overrides every Panel read, such as a server error or a retired address. */
    @Volatile var everyRead: Answer? = null

    /** While set, a read of a Panel waits here before it is answered, so a test can hold a refresh in flight. */
    @Volatile var holdReads: java.util.concurrent.CountDownLatch? = null

    /** Counted down when a read of a Panel has reached the server. */
    @Volatile var readArrived: java.util.concurrent.CountDownLatch? = null

    private val inFlight = java.util.concurrent.atomic.AtomicInteger()

    /** The most reads of Panels that were being answered at once. */
    @Volatile var mostReadsAtOnce = 0

    /** Overrides what a renewal of the sign-in answers, such as throttling or a server error; null renews as a real grant does. */
    @Volatile var renewal: Answer? = null

    /** Whether the server is reachable at all. */
    @Volatile var reachable = true

    @Volatile private var grantEnded = false
    @Volatile private var generation = 0
    @Volatile private var acceptedAccess = emptySet<String>()
    @Volatile private var acceptedRefresh = emptySet<String>()

    /** The last form the token address was posted. */
    @Volatile var lastTokenForm: Map<String, String> = emptyMap()

    @Volatile var lastRegistration: String = ""

    val origin: String get() = server.url("/").toString().trimEnd('/')

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                if (!reachable) return MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AT_START)
                return answer(request).let { reply ->
                    MockResponse().setResponseCode(reply.status).setBody(reply.body).also { response ->
                        reply.headers.forEach { (name, value) -> response.addHeader(name, value) }
                    }
                }
            }
        }
        server.start()
    }

    /** The pair a sign-in has just been given, as if the person had finished it. */
    fun issueSignIn(): Pair<String, String> = issue()

    /** The person pressed Disconnect in Cockpit's Settings, or lost access. */
    fun disconnect() {
        grantEnded = true
    }

    /** How many times a Panel's rows were read. */
    fun readsOf(panelId: String) = requests.count { it.method == "GET" && it.path!!.startsWith("/apps/v1/panels/$panelId?") }

    fun refreshes() = requests.count { it.path == "/oauth/token" && it.body.peek().readUtf8().contains("grant_type=refresh_token") }

    private fun issue(): Pair<String, String> {
        generation += 1
        val access = "access-$generation"
        val refresh = "refresh-$generation"
        acceptedAccess = acceptedAccess + access
        acceptedRefresh = acceptedRefresh + refresh
        return access to refresh
    }

    private fun bearer(request: RecordedRequest) = request.getHeader("Authorization")?.removePrefix("Bearer ")

    private fun answer(request: RecordedRequest): Answer {
        val path = request.path!!.substringBefore('?')
        return when {
            path == "/oauth/register" && request.method == "POST" -> {
                lastRegistration = request.body.peek().readUtf8()
                Answer(201, """{"client_id":"client-1","redirect_uris":["cockpit-widget://oauth"]}""")
            }
            path == "/oauth/token" && request.method == "POST" -> token(form(request.body.peek().readUtf8()))
            request.method != "GET" -> Answer(405, """{"error":"reads are asked for with GET"}""")
            bearer(request) !in acceptedAccess || grantEnded -> Answer(401, """{"error":"invalid_token"}""")
            path == "/apps/v1/panels" -> panelList
            path.startsWith("/apps/v1/panels/") -> {
                val during = inFlight.incrementAndGet()
                mostReadsAtOnce = maxOf(mostReadsAtOnce, during)
                try {
                    readArrived?.countDown()
                    holdReads?.await()
                    val date = request.requestUrl?.queryParameter("date")
                    if (date == null) {
                        Answer(400, """{"error":"date must be a day"}""")
                    } else {
                        everyRead ?: panelReads[path.removePrefix("/apps/v1/panels/")] ?: Answer(404, """{"error":"not found"}""")
                    }
                } finally {
                    inFlight.decrementAndGet()
                }
            }
            else -> Answer(404, """{"error":"not found"}""")
        }
    }

    private fun token(form: Map<String, String>): Answer {
        lastTokenForm = form
        return when (form["grant_type"]) {
            "authorization_code" -> {
                if (form["code"] != "the-code" || form["client_id"] != "client-1" || form["code_verifier"].isNullOrEmpty()) {
                    Answer(400, """{"error":"invalid_grant"}""")
                } else {
                    val (access, refresh) = issue()
                    Answer(200, tokens(access, refresh))
                }
            }
            "refresh_token" -> {
                val presented = form["refresh_token"]
                val refused = renewal
                if (refused != null) {
                    refused
                } else if (grantEnded || presented !in acceptedRefresh) {
                    Answer(400, """{"error":"invalid_grant"}""")
                } else {
                    // Rotated: the one presented is spent.
                    acceptedRefresh = acceptedRefresh - presented!!
                    val (access, refresh) = issue()
                    Answer(200, tokens(access, refresh))
                }
            }
            else -> Answer(400, """{"error":"unsupported_grant_type"}""")
        }
    }

    private fun tokens(access: String, refresh: String) =
        """{"access_token":"$access","refresh_token":"$refresh","expires_in":3600,"token_type":"bearer","resource":"$origin/apps"}"""

    private fun form(body: String): Map<String, String> = body.split('&').filter { it.isNotEmpty() }.associate {
        val (name, value) = it.split('=', limit = 2)
        URLDecoder.decode(name, "UTF-8") to URLDecoder.decode(value, "UTF-8")
    }

    override fun close() = server.shutdown()
}