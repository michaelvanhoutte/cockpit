package com.conselit.cockpit.widget

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Home-screen widget: several widgets each show their own Panel (A2). */
@RunWith(RobolectricTestRunner::class)
@Config(application = TestApp::class)
class SeveralWidgetsEachOwnPanel {
    private lateinit var cockpit: FakeCockpit
    private lateinit var phone: Phone
    private val workspace = Wire.json.decodeFromString<PanelList>(Samples.panelList).workspaces.single()
    private val falcon = "018f0000-0000-7000-8000-00000000a002"
    private val thisWeek = "018f0000-0000-7000-8000-00000000a003"

    @Before
    fun startPhone() {
        cockpit = FakeCockpit()
        cockpit.panelReads[falcon] = Answer(200, Samples.flatPanel)
        cockpit.panelReads[thisWeek] = Answer(200, Samples.groupedFilterPanel)
        phone = Phone(cockpit).signedIn()
    }

    @After
    fun stopCockpit() = cockpit.close()

    @Test
    fun `two widgets on two Panels, one refresh, each reads and draws its own`() {
        val first = phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        val second = phone.placeWidget(PanelEntry(thisWeek, "This week", "filter"), workspace)
        val before = cockpit.requests.size

        phone.refresh()

        assertEquals("Falcon", phone.text(phone.widget(first), R.id.panel_name))
        assertEquals("This week", phone.text(phone.widget(second), R.id.panel_name))
        assertEquals(listOf("Renew the domain", "Send the Q4 forecast to Sander"), phone.rows(first).map { phone.text(it, R.id.title) })
        assertEquals(
            listOf("Send the Q4 forecast to Sander", "Send the Q4 forecast to Sander", "Renew the domain"),
            phone.rowFactory(second).lines().filterIsInstance<Line.Item>().map { it.label },
        )
        assertEquals("one read for each Panel", 2, cockpit.requests.drop(before).count { it.path!!.startsWith("/apps/v1/panels/") })
    }

    @Test
    fun `two widgets on one Panel read it once`() {
        phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        val before = cockpit.readsOf(falcon)

        phone.refresh()

        assertEquals(1, cockpit.readsOf(falcon) - before)
    }

    @Test
    fun `one of them removed, its Panel is no longer read`() {
        val first = phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        phone.placeWidget(PanelEntry(thisWeek, "This week", "filter"), workspace)
        phone.refresh()
        val falconReads = cockpit.readsOf(falcon)
        val thisWeekReads = cockpit.readsOf(thisWeek)

        phone.removeWidget(first)
        phone.refresh()

        assertEquals(falconReads, cockpit.readsOf(falcon))
        assertEquals(thisWeekReads + 1, cockpit.readsOf(thisWeek))
        assertEquals(null, phone.graph.widgets.binding(first))
        assertEquals(null, phone.graph.widgets.kept(first))
    }
}