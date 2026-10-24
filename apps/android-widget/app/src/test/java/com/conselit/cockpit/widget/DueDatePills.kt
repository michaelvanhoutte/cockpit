package com.conselit.cockpit.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate

/**
 * Home-screen widget: a widget draws its Panel as the approved mock-up. The due
 * pill is its one calculation, so it is proved here, with no Android in sight (A1).
 */
class DueDatePills {
    private val today = LocalDate.parse("2026-10-23")

    private fun pill(due: String?) = duePill(due, today)

    @Test
    fun `a date passed says how many days ago, in red, and a date today is solid`() {
        assertEquals(DuePill("Overdue 2d", PillLook.OVERDUE), pill("2026-10-21"))
        assertEquals(DuePill("Overdue 1d", PillLook.OVERDUE), pill("2026-10-22"))
        assertEquals(DuePill("Due today", PillLook.TODAY), pill("2026-10-23"))
    }

    @Test
    fun `a date tomorrow or in two days is soft and one in three to seven days is outlined`() {
        assertEquals(DuePill("Due tomorrow", PillLook.NEAR), pill("2026-10-24"))
        assertEquals(DuePill("Due in 2d", PillLook.NEAR), pill("2026-10-25"))
        assertEquals(DuePill("Due in 3d", PillLook.WEEK), pill("2026-10-26"))
        assertEquals(DuePill("Due in 5d", PillLook.WEEK), pill("2026-10-28"))
        assertEquals(DuePill("Due in 7d", PillLook.WEEK), pill("2026-10-30"))
    }

    @Test
    fun `a date further than a week is a plain date and no date is nothing`() {
        assertEquals(DuePill("Due 4 Nov", PillLook.PLAIN), pill("2026-11-04"))
        assertEquals(DuePill("Due 31 Oct", PillLook.PLAIN), pill("2026-10-31"))
        assertEquals(DuePill("Due 9 Jan 27", PillLook.PLAIN), pill("2027-01-09"))
        assertNull(pill(null))
        assertNull(pill("not a day"))
    }
}