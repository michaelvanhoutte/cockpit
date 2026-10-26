package com.conselit.cockpit.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Home-screen widget: both screens keep their content clear of the status bar, the
 * navigation bar and the cut-out (A2). Android 15 draws every app edge to edge, so the
 * screen itself must move its content in by the bars the system reports.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = TestApp::class)
class ScreensClearOfBars {
    private lateinit var cockpit: FakeCockpit
    private lateinit var phone: Phone

    @Before
    fun startPhone() {
        cockpit = FakeCockpit()
        phone = Phone(cockpit).signedIn()
    }

    @After
    fun stopCockpit() = cockpit.close()

    private fun main() = Robolectric.buildActivity(MainActivity::class.java).setup().get()

    private fun picker(): PickerActivity {
        val widget = android.appwidget.AppWidgetManager.getInstance(phone.context).let {
            org.robolectric.Shadows.shadowOf(it).createWidget(PanelWidgetProvider::class.java, R.layout.widget)
        }
        return Robolectric.buildActivity(
            PickerActivity::class.java,
            Intent(phone.context, PickerActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widget),
        ).setup().get()
    }

    private fun contentOf(screen: Activity): View = screen.findViewById<ViewGroup>(android.R.id.content).getChildAt(0)

    private fun report(view: View, bars: Insets, cutOut: Insets = Insets.NONE) {
        val insets = WindowInsetsCompat.Builder()
            .setInsets(WindowInsetsCompat.Type.systemBars(), bars)
            .setInsets(WindowInsetsCompat.Type.displayCutout(), cutOut)
            .build()
        ViewCompat.dispatchApplyWindowInsets(view, insets)
    }

    private fun assertClearOfBars(screen: Activity) {
        val content = contentOf(screen)
        report(content, Insets.NONE)
        val (top, bottom, left, right) = listOf(content.paddingTop, content.paddingBottom, content.paddingLeft, content.paddingRight)

        report(content, Insets.of(12, 96, 16, 144))

        assertEquals("below the status bar", top + 96, content.paddingTop)
        assertEquals("above the navigation bar", bottom + 144, content.paddingBottom)
        assertEquals(left + 12, content.paddingLeft)
        assertEquals(right + 16, content.paddingRight)
    }

    @Test
    fun `the main screen keeps its text and button below the status bar and above the navigation bar`() {
        assertClearOfBars(main())
    }

    @Test
    fun `the picker keeps its heading and list below the status bar and above the navigation bar`() {
        assertClearOfBars(picker())
    }

    @Test
    fun `a notch at the side of a turned phone is cleared too`() {
        for (screen in listOf(main(), picker())) {
            val content = contentOf(screen)
            report(content, Insets.NONE)
            val left = content.paddingLeft

            report(content, Insets.of(0, 96, 0, 0), cutOut = Insets.of(80, 0, 0, 0))

            assertEquals(left + 80, content.paddingLeft)
        }
    }

    @Test
    fun `neither screen has an action bar for its content to slide under`() {
        assertNull(main().actionBar)
        assertNull(picker().actionBar)
    }

    @Test
    fun `the picker's title says what to do, and its heading is on the screen`() {
        val screen = picker()
        assertEquals("Pick a Panel", screen.title.toString())
        assertTrue(screen.texts().contains("Pick a Panel for this widget"))
    }
}
