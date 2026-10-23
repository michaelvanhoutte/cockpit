package com.conselit.cockpit.widget

import android.app.Application
import android.content.Intent
import android.view.View
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * Home-screen widget: a refresh shows the Panel as it is now, or says why it cannot
 * (A2: each answer of the fake drives one outcome).
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = TestApp::class)
class RefreshShowsPanelOrWhy {
    private lateinit var cockpit: FakeCockpit
    private lateinit var phone: Phone
    private val workspace = Wire.json.decodeFromString<PanelList>(Samples.panelList).workspaces.single()
    private val falcon = "018f0000-0000-7000-8000-00000000a002"
    private var id = 0

    @Before
    fun startPhone() {
        cockpit = FakeCockpit()
        cockpit.panelReads[falcon] = Answer(200, Samples.flatPanel)
        phone = Phone(cockpit).signedIn()
        id = phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
    }

    @After
    fun stopCockpit() = cockpit.close()

    private fun keepsTheLastListAndSaysOffline() {
        val before = phone.rowFactory(id).lines()
        phone.clock.advance(Duration.ofMinutes(90))
        phone.refresh()
        assertEquals("the last list stays", before, phone.rowFactory(id).lines())
        assertEquals("Updated 11:05 · offline", phone.text(phone.widget(id), R.id.updated))
        assertEquals("2", phone.text(phone.widget(id), R.id.count))
    }

    @Test
    fun `the rows are drawn and Updated shows the time`() {
        phone.refresh()
        assertEquals(2, phone.rowFactory(id).count)
        assertEquals("Updated 11:05", phone.text(phone.widget(id), R.id.updated))
        phone.clock.advance(Duration.ofMinutes(45))
        phone.refresh()
        assertEquals("Updated 11:50", phone.text(phone.widget(id), R.id.updated))
    }

    @Test
    fun `nothing answering keeps the last list and says offline on the Updated line`() {
        phone.refresh()
        cockpit.reachable = false
        keepsTheLastListAndSaysOffline()
    }

    @Test
    fun `a server error keeps the last list as offline does`() {
        phone.refresh()
        cockpit.everyRead = Answer(500, """{"error":"something broke"}""")
        keepsTheLastListAndSaysOffline()
    }

    @Test
    fun `reading too often keeps the last list as offline does`() {
        phone.refresh()
        cockpit.everyRead = Answer(429, """{"error":"Too many reads"}""", mapOf("retry-after" to "60"))
        keepsTheLastListAndSaysOffline()
    }

    @Test
    fun `a Panel not found says it was deleted, and a tap opens the picker for that widget`() {
        phone.refresh()
        cockpit.panelReads.remove(falcon)
        phone.refresh()

        val view = phone.widget(id)
        assertEquals("This panel was deleted, tap to pick another", phone.text(view, R.id.message))
        assertEquals("Falcon", phone.text(view, R.id.panel_name))
        assertEquals(View.GONE, view.findViewById<View>(R.id.rows).visibility)

        view.findViewById<View>(R.id.message).performClick()
        val opened = shadowOf(phone.context as Application).nextStartedActivity
        assertEquals(PickerActivity::class.java.name, opened.component!!.className)
        assertEquals(id, opened.getIntExtra(android.appwidget.AppWidgetManager.EXTRA_APPWIDGET_ID, -1))
    }

    @Test
    fun `an address the server has retired says to update the widget, and a tap opens the release page`() {
        phone.refresh()
        cockpit.everyRead = Answer(410, """{"error":"this address has been retired; the app needs a newer version"}""")
        phone.refresh()

        val view = phone.widget(id)
        assertEquals("Update Cockpit widget", phone.text(view, R.id.message))
        view.findViewById<View>(R.id.message).performClick()
        val opened = shadowOf(phone.context as Application).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, opened.action)
        assertEquals("https://github.com/michaelvanhoutte/cockpit/releases", opened.dataString)
    }

    @Test
    fun `a Panel read for the phone's own day, never the server's`() {
        phone.refresh()
        val read = cockpit.requests.last { it.path!!.startsWith("/apps/v1/panels/$falcon") }
        assertEquals("2026-10-23", read.requestUrl!!.queryParameter("date"))
        assertTrue(read.getHeader("Authorization")!!.startsWith("Bearer "))
    }
}