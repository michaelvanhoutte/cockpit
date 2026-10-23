package com.conselit.cockpit.widget

import android.os.PowerManager
import android.provider.Settings
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
import org.robolectric.shadows.ShadowAlertDialog

/**
 * Home-screen widget: right after sign-in the app asks once to be exempt from
 * battery optimisation (A2).
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = TestApp::class)
class BatteryStepAfterSignIn {
    private lateinit var cockpit: FakeCockpit
    private lateinit var phone: Phone
    private val workspace = Wire.json.decodeFromString<PanelList>(Samples.panelList).workspaces.single()
    private val falcon = "018f0000-0000-7000-8000-00000000a002"

    @Before
    fun startPhone() {
        cockpit = FakeCockpit()
        cockpit.panelReads[falcon] = Answer(200, Samples.flatPanel)
        phone = Phone(cockpit)
    }

    @After
    fun stopCockpit() = cockpit.close()

    /** A dialog hands its button presses on through the main thread's queue. */
    private fun idle() = shadowOf(android.os.Looper.getMainLooper()).idle()

    private fun exempt(yes: Boolean) =
        shadowOf(phone.context.getSystemService(PowerManager::class.java)).setIgnoringBatteryOptimizations(phone.context.packageName, yes)

    @Test
    fun `a first sign-in, not exempt, explains the list may be hours old and then opens Android's dialog`() {
        exempt(false)
        val signingIn = SigningIn(phone).fromTheApp()
        signingIn.comesHome()
        val screen = shadowOf(signingIn.screen.get())

        val dialog = ShadowAlertDialog.getLatestAlertDialog()
        assertNotNull(dialog)
        val message = shadowOf(dialog).message.toString()
        assertTrue(message, message.contains("hours old"))
        assertNull("Android's dialog waits for the answer to this one", screen.peekNextStartedActivity())

        dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick()
        idle()

        val opened = screen.nextStartedActivity
        assertEquals(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, opened.action)
        assertEquals("package:${phone.context.packageName}", opened.dataString)
    }

    @Test
    fun `declining is not asked again, and the widget still refreshes`() {
        exempt(false)
        val widget = phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        val signingIn = SigningIn(phone).fromTheApp()
        signingIn.comesHome()
        ShadowAlertDialog.getLatestAlertDialog().getButton(android.app.AlertDialog.BUTTON_NEGATIVE).performClick()
        idle()
        assertNull("Android's dialog was not opened", shadowOf(signingIn.screen.get()).peekNextStartedActivity())
        assertTrue("signed in, the widget read its Panel", cockpit.readsOf(falcon) >= 1)
        assertEquals("Updated 11:05", phone.text(phone.widget(widget), R.id.updated))

        // Signed out and in again, the question is not put twice.
        phone.graph.signOut()
        val dialogsBefore = ShadowAlertDialog.getShownDialogs().size
        SigningIn(phone).fromTheApp().comesHome()
        assertEquals(dialogsBefore, ShadowAlertDialog.getShownDialogs().size)
        assertTrue(phone.graph.session.isSignedIn())
    }

    @Test
    fun `a phone that already exempts the app is not asked`() {
        exempt(true)
        SigningIn(phone).fromTheApp().comesHome()

        assertNull(ShadowAlertDialog.getLatestAlertDialog())
        assertTrue(phone.graph.session.isSignedIn())
    }
}