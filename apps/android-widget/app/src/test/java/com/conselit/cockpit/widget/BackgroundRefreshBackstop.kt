package com.conselit.cockpit.widget

import android.app.AlarmManager
import android.content.Intent
import android.os.SystemClock
import androidx.work.WorkInfo
import androidx.work.WorkManager
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

/**
 * Home-screen widget: the widget refreshes in the background about every 30 minutes,
 * with an alarm as backstop (A2, with WorkManager's test driver and Robolectric's
 * alarms; the real cadence is the owner's walk on his phone).
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = TestApp::class)
class BackgroundRefreshBackstop {
    private lateinit var cockpit: FakeCockpit
    private lateinit var phone: Phone
    private val workspace = Wire.json.decodeFromString<PanelList>(Samples.panelList).workspaces.single()
    private val falcon = "018f0000-0000-7000-8000-00000000a002"

    @Before
    fun startPhone() {
        cockpit = FakeCockpit()
        cockpit.panelReads[falcon] = Answer(200, Samples.flatPanel)
        phone = Phone(cockpit).signedIn()
    }

    @After
    fun stopCockpit() = cockpit.close()

    private fun periodic(): List<WorkInfo> =
        WorkManager.getInstance(phone.context).getWorkInfosForUniqueWork(Background.PERIODIC).get()

    private val alarms get() = shadowOf(phone.context.getSystemService(AlarmManager::class.java))

    @Test
    fun `the first widget placed refreshes now and schedules the 30-minute refresh and the alarm`() {
        phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)

        assertEquals("a refresh now", 1, cockpit.readsOf(falcon))
        val scheduled = periodic().single()
        assertEquals(WorkInfo.State.ENQUEUED, scheduled.state)
        assertEquals(TimeUnit.MINUTES.toMillis(30), scheduled.periodicityInfo!!.repeatIntervalMillis)
        val alarm = alarms.nextScheduledAlarm!!
        assertEquals(AlarmManager.ELAPSED_REALTIME_WAKEUP, alarm.type)
        val thirtyMinutes = SystemClock.elapsedRealtime() + TimeUnit.MINUTES.toMillis(30)
        assertTrue("the alarm is 30 minutes on", Math.abs(alarm.triggerAtMs - thirtyMinutes) < TimeUnit.MINUTES.toMillis(1))
    }

    @Test
    fun `the app's process starting with a refresh already pending keeps the pending one`() {
        phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        val pending = periodic().single().id

        phone.app.onProcessStart()

        assertEquals(pending, periodic().single().id)
        assertEquals(WorkInfo.State.ENQUEUED, periodic().single().state)
    }

    @Test
    fun `the app's process starting with nothing pending schedules the refresh and the alarm again`() {
        phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        WorkManager.getInstance(phone.context).cancelUniqueWork(Background.PERIODIC).result.get()
        phone.context.getSystemService(AlarmManager::class.java).cancel(
            android.app.PendingIntent.getBroadcast(phone.context, 3, Intent(phone.context, AlarmReceiver::class.java), android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE),
        )
        assertNull(alarms.peekNextScheduledAlarm())

        phone.app.onProcessStart()

        assertEquals(WorkInfo.State.ENQUEUED, periodic().single { it.state != WorkInfo.State.CANCELLED }.state)
        assertNotNull(alarms.peekNextScheduledAlarm())
    }

    @Test
    fun `the alarm firing refreshes and sets itself again for 30 minutes on`() {
        phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        val reads = cockpit.readsOf(falcon)
        phone.clock.advance(java.time.Duration.ofMinutes(31))
        val fired = alarms.peekNextScheduledAlarm()!!

        alarms.fireAlarm(fired)
        shadowOf(android.os.Looper.getMainLooper()).idle()

        assertEquals("it refreshed", reads + 1, cockpit.readsOf(falcon))
        assertEquals("Updated 11:36", phone.text(phone.widget(phone.liveWidgetIds().single()), R.id.updated))
        val next = alarms.peekNextScheduledAlarm()
        assertNotNull("set again", next)
    }

    @Test
    fun `the last widget removed cancels the 30-minute refresh and the alarm`() {
        phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        assertNotNull(alarms.peekNextScheduledAlarm())

        phone.removeLastWidget()

        assertEquals(WorkInfo.State.CANCELLED, periodic().single().state)
        assertNull(alarms.peekNextScheduledAlarm())
    }
}