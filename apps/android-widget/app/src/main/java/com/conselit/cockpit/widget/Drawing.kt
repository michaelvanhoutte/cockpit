package com.conselit.cockpit.widget

import java.net.URLEncoder
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/*
 * Everything the widget decides before it touches a view: what a pill says, which
 * line sits under the heading, where a tap goes. No Android, no network, no clock
 * of its own, so each rule is a plain test.
 */

/** How loud a due pill is: a quiet outline within a week, a soft fill within two days, solid on the day, red once passed. */
enum class PillLook { OVERDUE, TODAY, NEAR, WEEK, PLAIN }

data class DuePill(val text: String, val look: PillLook)

/** How many days ahead a due date starts to wear a pill; further off it is a plain date. */
const val PILL_WITHIN_DAYS = 7L

private val DAY_AND_MONTH = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)
private val DAY_MONTH_AND_YEAR = DateTimeFormatter.ofPattern("d MMM yy", Locale.ENGLISH)

/**
 * The pill under a row's title, as Cockpit's own row draws it, counted in the
 * phone's calendar days. `null` for no due date, and for anything that is not
 * really a day.
 */
fun duePill(dueDate: String?, today: LocalDate): DuePill? {
    if (dueDate == null) return null
    val due = try {
        LocalDate.parse(dueDate)
    } catch (e: java.time.format.DateTimeParseException) {
        return null
    }
    val days = ChronoUnit.DAYS.between(today, due)
    return when {
        days < 0 -> DuePill("Overdue ${-days}d", PillLook.OVERDUE)
        days == 0L -> DuePill("Due today", PillLook.TODAY)
        days == 1L -> DuePill("Due tomorrow", PillLook.NEAR)
        days == 2L -> DuePill("Due in 2d", PillLook.NEAR)
        days <= PILL_WITHIN_DAYS -> DuePill("Due in ${days}d", PillLook.WEEK)
        else -> {
            val format = if (due.year == today.year) DAY_AND_MONTH else DAY_MONTH_AND_YEAR
            DuePill("Due ${due.format(format)}", PillLook.PLAIN)
        }
    }
}

/** A priority as the flag a row wears. Anything the server may add later reads as none. */
enum class Flag { HIGH, NORMAL, LOW, NONE }

fun flagOf(priority: String?): Flag = when (priority) {
    "high" -> Flag.HIGH
    "normal" -> Flag.NORMAL
    "low" -> Flag.LOW
    else -> Flag.NONE
}

/** What the widget says where there is no list to show. */
object Words {
    const val SIGNED_OUT = "Signed out, tap to sign in"
    const val PANEL_DELETED = "This panel was deleted, tap to pick another"
    const val NEEDS_NEWER_VERSION = "Update Cockpit widget"
    const val PICK_A_PANEL = "Tap to pick a Panel"
    const val REFRESHING = "Refreshing…"
    const val OFFLINE = "offline"

    /** Cockpit's own empty Panel says one of these, by what the Panel is. */
    const val NOTHING_FILED_HERE = "Nothing filed here yet."
    const val NOTHING_MATCHES_YET = "Nothing matches this yet."
}

private val CLOCK_TIME = DateTimeFormatter.ofPattern("HH:mm", Locale.ENGLISH)

/**
 * The line under the Panel's name. A refresh in flight says so; otherwise the
 * time of the last read, with *offline* beside it where the last try did not get
 * through, so a list that is old never looks fresh.
 */
fun updatedLine(updatedAt: Instant?, offline: Boolean, refreshing: Boolean, zone: ZoneId): String {
    if (refreshing) return Words.REFRESHING
    val time = if (updatedAt == null) "Not updated yet" else "Updated ${CLOCK_TIME.format(updatedAt.atZone(zone))}"
    return if (offline) "$time · ${Words.OFFLINE}" else time
}

/** The empty line for a Panel with nothing on it. */
fun emptyLine(kind: String): String = if (kind == "filter") Words.NOTHING_MATCHES_YET else Words.NOTHING_FILED_HERE

/** One line of the list the widget scrolls: a heading, or a row with everything it wears. */
sealed interface Line {
    data class Heading(val text: String) : Line

    data class Item(
        val itemId: String,
        val label: String,
        val flag: Flag,
        val pill: DuePill?,
        /** *Dashboard ▸ Panel* for each other Panel it is filed on, or *Inbox*; empty for an Item on this Panel alone. */
        val place: String,
        /** Where tapping it goes: its Copy link address. */
        val address: String,
    ) : Line
}

private const val PLACE_SEPARATOR = " · "

/**
 * The Panel's lines in its order and groups, exactly as the server returned them:
 * a heading for each group that has one, then its rows. A heading that names its
 * Dashboard reads *Dashboard ▸ Panel*, as a place does.
 */
fun linesOf(read: PanelRead, origin: String, today: LocalDate): List<Line> =
    read.groups.flatMap { group ->
        val heading = group.heading?.let { heading ->
            Line.Heading(if (heading.dashboard != null) "${heading.dashboard} ▸ ${heading.name}" else heading.name)
        }
        listOfNotNull(heading) + group.rows.map { row ->
            Line.Item(
                itemId = row.itemId,
                label = row.label,
                flag = flagOf(row.priority),
                pill = duePill(row.dueDate, today),
                place = row.places.joinToString(PLACE_SEPARATOR),
                address = itemAddress(origin, read.workspace.id, row.itemId),
            )
        }
    }

private fun encode(part: String) = URLEncoder.encode(part, "UTF-8")

private fun root(origin: String) = origin.trimEnd('/')

/** The Item at its Copy link address, which the installed Cockpit opens, or the browser without it. */
fun itemAddress(origin: String, workspaceId: String, itemId: String) =
    "${root(origin)}/w/${encode(workspaceId)}?item=${encode(itemId)}"

/** Capture in the Panel's Workspace, with *File on* holding the Panel for a Panel of items. */
fun captureAddress(origin: String, workspaceId: String, panelId: String, kind: String): String {
    val base = "${root(origin)}/capture?workspace=${encode(workspaceId)}"
    return if (kind == "items") "$base&panel=${encode(panelId)}" else base
}

/** `#2f6f9f` as an ARGB int, or a neutral grey for anything else, so a colour Cockpit one day writes differently never stops a draw. */
fun colorOf(hex: String?): Int {
    val digits = hex?.removePrefix("#")
    val value = digits?.takeIf { it.length == 6 }?.toLongOrNull(16)
    return if (value == null) 0xFF8B8D94.toInt() else (0xFF000000L or value).toInt()
}
