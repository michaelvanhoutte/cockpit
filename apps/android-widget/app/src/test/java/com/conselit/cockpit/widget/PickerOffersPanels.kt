package com.conselit.cockpit.widget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.widget.ListView
import android.widget.TextView
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config

/**
 * Home-screen widget: the picker offers Panels of items and Filter panels, grouped
 * by Workspace and then Dashboard, in tab order (A2, reading the fake's Panel list).
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = TestApp::class)
class PickerOffersPanels {
    private lateinit var cockpit: FakeCockpit
    private lateinit var phone: Phone

    private lateinit var work: ManualExecutor

    @Before
    fun startPhone() {
        cockpit = FakeCockpit()
        work = ManualExecutor()
        phone = Phone(cockpit, work).signedIn()
    }

    @After
    fun stopCockpit() = cockpit.close()

    private fun pickerFor(widgetId: Int): ActivityController<PickerActivity> = Robolectric.buildActivity(
        PickerActivity::class.java,
        Intent(phone.context, PickerActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId),
    ).setup()

    private fun newWidget() = shadowOf(AppWidgetManager.getInstance(phone.context)).createWidget(PanelWidgetProvider::class.java, R.layout.widget)

    private fun offered(picker: ActivityController<PickerActivity>): List<String> {
        val list = picker.get().window.decorView.all<ListView>().single()
        return (0 until list.adapter.count).map { (list.adapter.getView(it, null, list) as TextView).text.toString() }
    }

    @Test
    fun `two Workspaces with Dashboards are grouped and ordered as the list says`() {
        cockpit.panelList = Answer(
            200,
            """
            {"workspaces":[
              {"id":"w1","name":"Work","color":"#2f6f9f","dashboards":[
                {"id":"d1","name":"Day to day","panels":[{"id":"p1","name":"Admin","kind":"items"},{"id":"p2","name":"This week","kind":"filter"}]},
                {"id":"d2","name":"Hasselt","panels":[{"id":"p3","name":"Proposals","kind":"items"}]}]},
              {"id":"w2","name":"Home","color":"#3a7d44","dashboards":[
                {"id":"d3","name":"Chores","panels":[{"id":"p4","name":"Garden","kind":"items"}]}]}
            ]}
            """.trimIndent(),
        )
        assertEquals(
            listOf("Work", "Day to day", "Admin", "This week", "Hasselt", "Proposals", "Home", "Chores", "Garden"),
            offered(pickerFor(newWidget())),
        )
    }

    @Test
    fun `a Workspace with no Panel of items or Filter panel is not offered, nor a Dashboard with none`() {
        cockpit.panelList = Answer(
            200,
            """
            {"workspaces":[
              {"id":"w1","name":"Notes only","color":"#2f6f9f","dashboards":[
                {"id":"d1","name":"Agenda","panels":[{"id":"p1","name":"Standing agenda","kind":"text"}]}]},
              {"id":"w2","name":"Empty","color":"#2f6f9f","dashboards":[]},
              {"id":"w3","name":"Home","color":"#3a7d44","dashboards":[
                {"id":"d2","name":"Words","panels":[{"id":"p2","name":"Notes","kind":"text"}]},
                {"id":"d3","name":"Chores","panels":[{"id":"p3","name":"Garden","kind":"items"},{"id":"p4","name":"Letter","kind":"text"}]}]}
            ]}
            """.trimIndent(),
        )
        assertEquals(listOf("Home", "Chores", "Garden"), offered(pickerFor(newWidget())))
    }

    @Test
    fun `a Panel picked is shown by the widget at once, and the widget is placed`() {
        cockpit.panelReads["018f0000-0000-7000-8000-00000000a001"] = Answer(200, Samples.flatPanel)
        val id = phone.placeWidget()
        val picker = pickerFor(id)
        val list = picker.get().window.decorView.all<ListView>().single()
        val position = (0 until list.adapter.count).first { (list.adapter.getView(it, null, list) as TextView).text == "Admin" }
        assertEquals("a heading is not a choice", false, list.adapter.isEnabled(0))

        list.performItemClick(null, position, list.adapter.getItemId(position))

        assertTrue(picker.get().isFinishing)
        assertEquals(android.app.Activity.RESULT_OK, shadowOf(picker.get()).resultCode)
        assertEquals(id, shadowOf(picker.get()).resultIntent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1))
        assertEquals(Binding("018f0000-0000-7000-8000-00000000a001", "items", "0015-first-workspace"), phone.graph.widgets.binding(id))
        // Before any read has come back, the widget already names its Panel.
        val view = phone.widget(id)
        assertEquals("Admin", phone.text(view, R.id.panel_name))
        assertEquals("Refreshing…", phone.text(view, R.id.updated))
        assertEquals(0, phone.rowFactory(id).count)

        work.runAll()
        assertEquals("then its rows", 2, phone.rowFactory(id).count)
    }

    @Test
    fun `a list that cannot be loaded says so and offers to try again`() {
        cockpit.panelList = Answer(500, "{}")
        val picker = pickerFor(newWidget())
        assertTrue(picker.get().texts().contains("Could not load your Panels."))
        cockpit.panelList = Answer(200, Samples.panelList)
        picker.get().button("Try again").performClick()
        assertEquals(listOf("Work", "Day to day", "Admin", "This week"), offered(picker))
    }
}