package com.conselit.cockpit.widget

import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.PowerManager
import android.widget.ListView
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Home-screen widget: one sign-in serves every widget on the phone, and losing it
 * leaves every widget saying so. The stored sign-in and the widgets meet only in
 * the running app, so this runs it (A2) against a fake Cockpit.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = TestApp::class)
class OneSignInServesEveryWidget {
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
        phone = Phone(cockpit)
        // Android's own "already exempt" answer is its own test.
        shadowOf(phone.context.getSystemService(PowerManager::class.java)).setIgnoringBatteryOptimizations(phone.context.packageName, true)
    }

    @After
    fun stopCockpit() = cockpit.close()

    @Test
    fun `sign-in finishing lets the picker open on the Panels, and every widget be given one`() {
        val widgetId = shadowOf(AppWidgetManager.getInstance(phone.context)).createWidget(PanelWidgetProvider::class.java, R.layout.widget)
        val picker = Robolectric.buildActivity(
            PickerActivity::class.java,
            Intent(phone.context, PickerActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId),
        ).setup()
        assertTrue("the picker asks to sign in first", picker.get().texts().any { it.startsWith("Sign in to Cockpit") })

        val signingIn = SigningIn(phone).fromAWidget()
        signingIn.comesHome()
        assertTrue("the screen closes itself, back to the picker", signingIn.screen.get().isFinishing)

        picker.resume()
        val list = picker.get().window.decorView.all<ListView>().single()
        val offered = (0 until list.adapter.count).map { (list.adapter.getView(it, null, list) as android.widget.TextView).text.toString() }
        assertEquals(listOf("Work", "Day to day", "Admin", "This week"), offered)
    }

    @Test
    fun `the browser is sent to Cockpit asking to read Panels, and the code is traded with the secret that proves it was this app`() {
        val signingIn = SigningIn(phone).fromTheApp()
        val address = signingIn.browserAddress
        assertEquals("${cockpit.origin}/oauth/authorize", address.toString().substringBefore('?'))
        assertEquals("code", address.getQueryParameter("response_type"))
        assertEquals("client-1", address.getQueryParameter("client_id"))
        assertEquals("cockpit-widget://oauth", address.getQueryParameter("redirect_uri"))
        assertEquals("${cockpit.origin}/apps", address.getQueryParameter("resource"))
        assertEquals("S256", address.getQueryParameter("code_challenge_method"))
        assertNull(address.getQueryParameter("scope"))
        assertTrue(cockpit.lastRegistration.contains("\"redirect_uris\":[\"cockpit-widget://oauth\"]"))
        assertTrue(cockpit.lastRegistration.contains("\"token_endpoint_auth_method\":\"none\""))

        signingIn.comesHome()

        assertEquals("the-code", cockpit.lastTokenForm["code"])
        assertEquals("cockpit-widget://oauth", cockpit.lastTokenForm["redirect_uri"])
        assertEquals(address.getQueryParameter("code_challenge"), Pkce.challenge(cockpit.lastTokenForm.getValue("code_verifier")))
        assertTrue(phone.graph.session.isSignedIn())
    }

    @Test
    fun `a way back that is not the answer to this sign-in signs nobody in`() {
        val signingIn = SigningIn(phone).fromTheApp()
        signingIn.comesHome(state = "another-sign-in")
        assertEquals(false, phone.graph.session.isSignedIn())
        assertNull(cockpit.lastTokenForm["code"])
    }

    @Test
    fun `another app sending the private address cannot cancel the sign-in under way`() {
        val signingIn = SigningIn(phone).fromTheApp()
        signingIn.comesHome(state = "another-sign-in")
        signingIn.comesHome()
        assertTrue(phone.graph.session.isSignedIn())
    }

    /** A phone whose key store refuses everything. */
    private val unable = object : SecretBox {
        override fun seal(plain: String): String = throw java.security.ProviderException("Keystore operation failed")
        override fun open(sealed: String): String? = null
    }

    @Test
    fun `a phone whose key store cannot keep a sign-in safe never sends the browser, and says so`() {
        phone = Phone(cockpit, secretBox = unable)
        val screen = Robolectric.buildActivity(MainActivity::class.java).setup()

        screen.get().button("Sign in").performClick()

        assertNull("no browser was opened", shadowOf(screen.get()).peekNextStartedActivity())
        assertTrue(screen.get().texts().any { it.startsWith("This phone could not keep a sign-in safe") })
    }

    @Test
    fun `a code traded on a phone whose key store refuses signs nobody in`() {
        phone = Phone(cockpit, secretBox = unable)
        phone.graph.session.saveClientId("client-1")

        val outcome = phone.graph.client.signIn("the-code", "a-verifier")

        assertEquals(SignedIn.Failed("could not keep the sign-in safe on this phone"), outcome)
        assertEquals(false, phone.graph.session.isSignedIn())
    }

    @Test
    fun `a refresh refused because the app was disconnected leaves every widget saying signed out, with its kept list wiped`() {
        phone.signedIn()
        val first = phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        val second = phone.placeWidget(PanelEntry(thisWeek, "This week", "filter"), workspace)
        phone.refresh()
        assertNotNull(phone.graph.widgets.kept(first)?.read)
        assertNotNull(phone.graph.widgets.kept(second)?.read)

        cockpit.disconnect()
        phone.refresh()

        for (id in listOf(first, second)) {
            assertEquals("Signed out, tap to sign in", phone.text(phone.widget(id), R.id.message))
            assertNull("the kept list is gone", phone.graph.widgets.kept(id))
        }
        assertEquals(false, phone.graph.session.isSignedIn())
    }

    @Test
    fun `a widget tapped while signed out opens sign-in`() {
        val id = phone.placeWidget(PanelEntry(falcon, "Falcon", "items"), workspace)
        assertEquals("Signed out, tap to sign in", phone.text(phone.widget(id), R.id.message))

        phone.widget(id).findViewById<android.view.View>(R.id.message).performClick()

        val opened = shadowOf(phone.context as android.app.Application).nextStartedActivity
        assertEquals(MainActivity::class.java.name, opened.component!!.className)
        assertEquals(MainActivity.ACTION_SIGN_IN, opened.action)
    }
}