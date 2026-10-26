package com.conselit.cockpit.widget

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

/**
 * Home-screen widget: what a widget says and where a tap goes, decided before any
 * view is touched (A1): the lines of a Panel in the server's order and groups, the
 * Updated line, and the addresses a tap opens.
 */
class WhatTheWidgetSays {
    private val today = LocalDate.parse("2026-10-23")
    private val origin = "https://cockpit.vanhoutte-michael.workers.dev"

    @Test
    fun `a Panel of items is its rows in the server's order, with no heading`() {
        val lines = linesOf(Wire.json.decodeFromString<PanelRead>(Samples.flatPanel), origin, today)
        assertEquals(
            listOf(
                Line.Item(
                    "018f0000-0000-7000-8000-00000000e002", "Renew the domain", Flag.NONE, null, "",
                    "$origin/w/0015-first-workspace?item=018f0000-0000-7000-8000-00000000e002",
                ),
                Line.Item(
                    "018f0000-0000-7000-8000-00000000e001", "Send the Q4 forecast to Sander", Flag.HIGH,
                    DuePill("Overdue 2d", PillLook.OVERDUE), "Day to day ▸ Admin",
                    "$origin/w/0015-first-workspace?item=018f0000-0000-7000-8000-00000000e001",
                ),
            ),
            lines,
        )
    }

    @Test
    fun `a Filter panel grouped by Panel is a heading for each group with its rows under it`() {
        val lines = linesOf(Wire.json.decodeFromString<PanelRead>(Samples.groupedFilterPanel), origin, today)
        assertEquals(
            listOf("Day to day ▸ Admin", null, "Day to day ▸ Falcon", null, null),
            lines.map { (it as? Line.Heading)?.text },
        )
        assertEquals(
            listOf("Send the Q4 forecast to Sander", "Send the Q4 forecast to Sander", "Renew the domain"),
            lines.filterIsInstance<Line.Item>().map { it.label },
        )
    }

    @Test
    fun `a row filed on two other Panels says both on its place line`() {
        val read = PanelRead(
            PanelInfo("p", "This week", "filter"),
            WorkspaceInfo("w", "Work", "#2f6f9f"),
            1,
            listOf(Group(null, listOf(Row("i", "Review", "normal", null, listOf("Work ▸ Proposals", "Work ▸ Hasselt"))))),
        )
        assertEquals("Work ▸ Proposals · Work ▸ Hasselt", (linesOf(read, origin, today).single() as Line.Item).place)
    }

    @Test
    fun `the Updated line says the time of the last read, and offline beside it where the last try did not get through`() {
        val at = Instant.parse("2026-10-23T11:05:00Z")
        assertEquals("Updated 11:05", updatedLine(at, offline = false, refreshing = false, zone = ZoneOffset.UTC))
        assertEquals("Updated 11:05 · offline", updatedLine(at, offline = true, refreshing = false, zone = ZoneOffset.UTC))
        assertEquals("Updated 13:05", updatedLine(at, offline = false, refreshing = false, zone = ZoneOffset.ofHours(2)))
        assertEquals("Refreshing…", updatedLine(at, offline = true, refreshing = true, zone = ZoneOffset.UTC))
        assertEquals("Not updated yet · offline", updatedLine(null, offline = true, refreshing = false, zone = ZoneOffset.UTC))
    }

    @Test
    fun `Capture's address names the Workspace, and the Panel only for a Panel of items`() {
        assertEquals("$origin/capture?workspace=w-1&panel=p-1", captureAddress(origin, "w-1", "p-1", "items"))
        assertEquals("$origin/capture?workspace=w-1", captureAddress(origin, "w-1", "p-1", "filter"))
        assertEquals("$origin/capture?workspace=w-1", captureAddress("$origin/", "w-1", "p-1", "filter"))
    }

    @Test
    fun `an Item's address is escaped, so an id with odd characters stays one address`() {
        assertEquals("$origin/w/a%26b?item=c%3Dd", itemAddress(origin, "a&b", "c=d"))
    }

    @Test
    fun `a Workspace colour is read as written and a colour it cannot read is grey`() {
        assertEquals(0xFF2F6F9F.toInt(), colorOf("#2f6f9f"))
        assertEquals(0xFF8B8D94.toInt(), colorOf("blue"))
        assertEquals(0xFF8B8D94.toInt(), colorOf(null))
    }
}