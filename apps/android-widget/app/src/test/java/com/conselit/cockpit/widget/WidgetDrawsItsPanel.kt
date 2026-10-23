package com.conselit.cockpit.widget

import android.graphics.drawable.GradientDrawable
import android.view.View
import android.widget.ImageView
import android.widget.TextView
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Home-screen widget: a widget draws its Panel as the approved mock-up. The widget's
 * own views are inflated and read (A2); the pill's arithmetic is `DueDatePills` (A1).
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = TestApp::class)
class WidgetDrawsItsPanel {
    private lateinit var cockpit: FakeCockpit
    private lateinit var phone: Phone
    private val workspace = Wire.json.decodeFromString<PanelList>(Samples.panelList).workspaces.single()
    private val flatPanelId = "018f0000-0000-7000-8000-00000000a002"
    private val filterPanelId = "018f0000-0000-7000-8000-00000000a003"

    @Before
    fun startPhone() {
        cockpit = FakeCockpit()
        phone = Phone(cockpit).signedIn()
    }

    @After
    fun stopCockpit() = cockpit.close()

    private fun widgetShowing(sample: String, panelId: String, kind: String, mutate: (PanelRead) -> PanelRead = { it }): Int {
        val read = mutate(Wire.json.decodeFromString<PanelRead>(sample))
        cockpit.panelReads[panelId] = Answer(200, Wire.json.encodeToString(PanelRead.serializer(), read))
        val id = phone.placeWidget(PanelEntry(panelId, read.panel.name, kind), workspace)
        phone.refresh()
        return id
    }

    private fun row(label: String, priority: String?, due: String?, places: List<String>) =
        Row("item-$label", label, priority, due, places)

    private fun onePanel(vararg rows: Row) = { read: PanelRead -> read.copy(count = rows.size, groups = listOf(Group(null, rows.toList()))) }

    @Test
    fun `any Panel shows the Workspace's colour dot, the Panel's name and count, and when it was updated`() {
        val id = widgetShowing(Samples.flatPanel, flatPanelId, "items")
        val view = phone.widget(id)
        assertEquals("Falcon", phone.text(view, R.id.panel_name))
        assertEquals("2", phone.text(view, R.id.count))
        assertEquals("Updated 11:05", phone.text(view, R.id.updated))
        assertTrue(phone.isShown(view, R.id.dot))
        assertTrue(phone.isShown(view, R.id.refresh))
        assertTrue(phone.isShown(view, R.id.add))
    }

    @Test
    fun `priority High, Normal, Low and none show a red, amber and grey flag and a faint one`() {
        val id = widgetShowing(
            Samples.flatPanel, flatPanelId, "items",
            onePanel(row("a", "high", null, listOf()), row("b", "normal", null, listOf()), row("c", "low", null, listOf()), row("d", null, null, listOf())),
        )
        val flags = phone.rows(id).map { shadowResource(it.findViewById<ImageView>(R.id.flag)) }
        assertEquals(listOf(R.drawable.flag_high, R.drawable.flag_normal, R.drawable.flag_low, R.drawable.flag_unset), flags)
    }

    private fun shadowResource(view: ImageView): Int = org.robolectric.Shadows.shadowOf(view.drawable).createdFromResId

    @Test
    fun `a row filed elsewhere says where, on two others says both, and on nowhere says Inbox`() {
        val id = widgetShowing(
            Samples.flatPanel, flatPanelId, "items",
            onePanel(
                row("a", null, null, listOf("Day to day ▸ Admin")),
                row("b", null, null, listOf("Day to day ▸ Admin", "Day to day ▸ Falcon")),
                row("c", null, null, listOf("Inbox")),
            ),
        )
        assertEquals(
            listOf("Day to day ▸ Admin", "Day to day ▸ Admin · Day to day ▸ Falcon", "Inbox"),
            phone.rows(id).map { phone.text(it, R.id.place) },
        )
    }

    @Test
    fun `a row's due date shows as the pill of its look, and a far date or none as plain or nothing`() {
        val id = widgetShowing(
            Samples.flatPanel, flatPanelId, "items",
            onePanel(
                row("a", null, "2026-10-21", listOf()),
                row("b", null, "2026-10-23", listOf()),
                row("c", null, "2026-10-24", listOf()),
                row("d", null, "2026-10-28", listOf()),
                row("e", null, "2026-11-04", listOf()),
                row("f", null, null, listOf()),
            ),
        )
        val shown = phone.rows(id).map { view ->
            listOf(R.id.pill_overdue, R.id.pill_today, R.id.pill_near, R.id.pill_week, R.id.pill_plain)
                .filter { phone.isShown(view, it) }
                .map { it to phone.text(view, it) }
        }
        assertEquals(
            listOf(
                listOf(R.id.pill_overdue to "Overdue 2d"),
                listOf(R.id.pill_today to "Due today"),
                listOf(R.id.pill_near to "Due tomorrow"),
                listOf(R.id.pill_week to "Due in 5d"),
                listOf(R.id.pill_plain to "Due 4 Nov"),
                emptyList(),
            ),
            shown,
        )
    }

    @Test
    fun `a Filter panel grouped by Panel draws a heading for each group with its rows under it`() {
        val id = widgetShowing(Samples.groupedFilterPanel, filterPanelId, "filter")
        val lines = phone.rowFactory(id)
        assertEquals(5, lines.count)
        val views = (0 until lines.count).map { lines.getViewAt(it).apply(phone.context, android.widget.FrameLayout(phone.context)) }
        assertEquals("Day to day ▸ Admin", views[0].findViewById<TextView>(R.id.heading).text.toString())
        assertEquals("Send the Q4 forecast to Sander", phone.text(views[1], R.id.title))
        assertEquals("Day to day ▸ Falcon", views[2].findViewById<TextView>(R.id.heading).text.toString())
        assertEquals("Renew the domain", phone.text(views[4], R.id.title))
    }

    @Test
    fun `a Panel with nothing on it shows its heading and Cockpit's own empty line`() {
        val items = widgetShowing(Samples.flatPanel, flatPanelId, "items") { it.copy(count = 0, groups = listOf(Group(null, emptyList()))) }
        val itemsView = phone.widget(items)
        assertEquals("Falcon", phone.text(itemsView, R.id.panel_name))
        assertTrue(phone.isShown(itemsView, R.id.message))
        assertEquals("Nothing filed here yet.", phone.text(itemsView, R.id.message))

        val filter = widgetShowing(Samples.groupedFilterPanel, filterPanelId, "filter") { it.copy(count = 0, groups = emptyList()) }
        assertEquals("Nothing matches this yet.", phone.text(phone.widget(filter), R.id.message))
    }

    private fun colours(view: View): Triple<Int, Int, Int> {
        val background = ((view.findViewById<View>(R.id.root).background) as GradientDrawable).color!!.defaultColor
        return Triple(background, view.findViewById<TextView>(R.id.panel_name).currentTextColor, view.findViewById<TextView>(R.id.updated).currentTextColor)
    }

    @Test
    fun `the phone in light shows the mock-up's light colours`() {
        val id = widgetShowing(Samples.flatPanel, flatPanelId, "items")
        assertEquals(Triple(0xFFF7F7F5.toInt(), 0xFF16181D.toInt(), 0xFF5A5F6D.toInt()), colours(phone.widget(id)))
    }

    @Test
    @Config(qualifiers = "night")
    fun `the phone in dark shows the mock-up's dark colours`() {
        val id = widgetShowing(Samples.flatPanel, flatPanelId, "items")
        assertEquals(Triple(0xFF23242A.toInt(), 0xFFE4E5EA.toInt(), 0xFF8A8E9A.toInt()), colours(phone.widget(id)))
    }
}