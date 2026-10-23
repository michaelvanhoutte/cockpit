package com.conselit.cockpit.widget

import android.content.Intent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Home-screen widget: the refresh button refreshes now, and two refreshes at once
 * leave one result (A2).
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = TestApp::class)
class RefreshNowAndTwiceAtOnce {
    private lateinit var cockpit: FakeCockpit
    private lateinit var work: ManualExecutor
    private lateinit var phone: Phone
    private val workspace = Wire.json.decodeFromString<PanelList>(Samples.panelList).workspaces.single()
    private val falcon = "018f0000-0000-7000-8000-00000000a002"
    private var id = 0

    @Before
    fun startPhone() {
        cockpit = FakeCockpit()
        cockpit.panelReads[falcon] = Answer(200, Samples.flatPanel)
        work = ManualExecutor()
        phone = Phone(cockpit, work).signedIn()
        id = phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        work.runAll()
    }

    @After
    fun stopCockpit() = cockpit.close()

    private fun tapRefresh() = PanelWidgetProvider().onReceive(phone.context, Intent(PanelWidgetProvider.ACTION_REFRESH))

    @Test
    fun `refresh tapped says Refreshing, then shows the rows and when they were read`() {
        assertEquals("Updated 11:05", phone.text(phone.widget(id), R.id.updated))
        phone.clock.advance(java.time.Duration.ofMinutes(20))

        tapRefresh()
        assertEquals("Refreshing…", phone.text(phone.widget(id), R.id.updated))
        assertEquals("the rows are not thrown away while it reads", 2, phone.rowFactory(id).count)

        work.runAll()
        assertEquals("Updated 11:25", phone.text(phone.widget(id), R.id.updated))
        assertEquals(2, phone.rowFactory(id).count)
    }

    @Test
    fun `refresh tapped while a background refresh is running draws one result and never leaves Refreshing showing`() {
        cockpit.holdReads = CountDownLatch(1)
        cockpit.readArrived = CountDownLatch(1)
        val background = Thread { phone.refresh() }
        background.start()
        assertEquals(true, cockpit.readArrived!!.await(10, TimeUnit.SECONDS))

        tapRefresh()
        assertEquals("Refreshing…", phone.text(phone.widget(id), R.id.updated))

        cockpit.holdReads!!.countDown()
        background.join(10_000)
        work.runAll()

        assertEquals("Updated 11:05", phone.text(phone.widget(id), R.id.updated))
        assertFalse(phone.text(phone.widget(id), R.id.updated).contains("Refreshing"))
        assertEquals(2, phone.rowFactory(id).count)
    }
}
