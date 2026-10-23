package com.conselit.cockpit.widget

import android.app.Application
import android.content.Intent
import android.view.View
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Home-screen widget: tapping goes into Cockpit at the right place (A2, the address
 * is built from the answer and the widget's Panel).
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = TestApp::class)
class TappingGoesIntoCockpit {
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

    private fun tapped(widgetId: Int, button: Int): Intent {
        phone.widget(widgetId).findViewById<View>(button).performClick()
        return shadowOf(phone.context as Application).nextStartedActivity
    }

    @Test
    fun `a row opens that Item at its Copy link address`() {
        val id = phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        phone.refresh()
        val rows = phone.rowFactory(id).lines().filterIsInstance<Line.Item>()
        assertEquals(
            listOf(
                "${cockpit.origin}/w/0015-first-workspace?item=018f0000-0000-7000-8000-00000000e002",
                "${cockpit.origin}/w/0015-first-workspace?item=018f0000-0000-7000-8000-00000000e001",
            ),
            rows.map { it.address },
        )
    }

    @Test
    fun `plus on a Panel of items opens Capture with that Workspace and Panel in its address`() {
        val id = phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        phone.refresh()
        val opened = tapped(id, R.id.add)
        assertEquals(Intent.ACTION_VIEW, opened.action)
        assertEquals("${cockpit.origin}/capture?workspace=0015-first-workspace&panel=$falcon", opened.dataString)
    }

    @Test
    fun `plus on a Filter panel opens Capture with that Workspace only`() {
        val id = phone.placeWidget(PanelEntry(thisWeek, "This week", "filter"), workspace)
        phone.refresh()
        val opened = tapped(id, R.id.add)
        assertEquals("${cockpit.origin}/capture?workspace=0015-first-workspace", opened.dataString)
    }
}