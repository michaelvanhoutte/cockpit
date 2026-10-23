package com.conselit.cockpit.widget

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Home-screen widget: signing out leaves nothing of your Panels on the phone (A2). */
@RunWith(RobolectricTestRunner::class)
@Config(application = TestApp::class)
class SigningOutLeavesNothing {
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
    fun `sign-out after lists were kept leaves every kept list gone and every widget saying signed out`() {
        val first = phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        val second = phone.placeWidget(PanelEntry(thisWeek, "This week", "filter"), workspace)
        phone.refresh()
        assertNotNull(phone.graph.widgets.kept(first)?.read)

        val screen = Robolectric.buildActivity(MainActivity::class.java).setup()
        screen.get().button("Sign out on this phone").performClick()

        for (id in listOf(first, second)) {
            assertNull("no list kept", phone.graph.widgets.kept(id))
            assertEquals("Signed out, tap to sign in", phone.text(phone.widget(id), R.id.message))
            assertEquals(0, phone.rowFactory(id).count)
        }
        assertFalse(phone.graph.session.isSignedIn())
        val kept = phone.context.getSharedPreferences("kept", android.content.Context.MODE_PRIVATE)
        assertEquals("nothing of a Panel is left in storage", emptyMap<String, Any?>(), kept.all)
    }

    @Test
    fun `signing in again brings every widget back to its own Panel`() {
        val first = phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        phone.refresh()
        phone.graph.signOut()
        phone.graph.renderer.drawAll(refreshing = false)

        phone.signedIn()
        phone.refresh()

        assertEquals("Falcon", phone.text(phone.widget(first), R.id.panel_name))
        assertEquals(2, phone.rowFactory(first).count)
    }

    @Test
    fun `the sign-in is kept sealed in the app's private storage, not as written`() {
        val stored = phone.context.getSharedPreferences("session", android.content.Context.MODE_PRIVATE).getString("session", null)!!
        assertTrue("written through the secret box", stored.startsWith("sealed:"))
    }
}