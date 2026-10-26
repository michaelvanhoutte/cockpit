package com.conselit.cockpit.widget

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * What Cockpit's two reads answer, as far as this app depends on it. A field that
 * is not named here is ignored, so the server may add fields freely; one named
 * here that goes missing or changes kind is a breaking change, which the server
 * retires with a new address rather than shipping.
 */
@Serializable
data class PanelList(val workspaces: List<WorkspaceEntry> = emptyList())

@Serializable
data class WorkspaceEntry(
    val id: String,
    val name: String,
    val color: String,
    val dashboards: List<DashboardEntry> = emptyList(),
)

@Serializable
data class DashboardEntry(val id: String, val name: String, val panels: List<PanelEntry> = emptyList())

@Serializable
data class PanelEntry(val id: String, val name: String, val kind: String)

@Serializable
data class PanelRead(
    val panel: PanelInfo,
    val workspace: WorkspaceInfo,
    val count: Int = 0,
    val groups: List<Group> = emptyList(),
)

@Serializable
data class PanelInfo(val id: String, val name: String, val kind: String, val dashboardId: String? = null)

@Serializable
data class WorkspaceInfo(val id: String, val name: String, val color: String)

@Serializable
data class Group(val heading: Heading? = null, val rows: List<Row> = emptyList())

@Serializable
data class Heading(val name: String, val dashboard: String? = null)

@Serializable
data class Row(
    val itemId: String,
    val label: String,
    val priority: String? = null,
    val dueDate: String? = null,
    val places: List<String> = emptyList(),
)

/** The kinds of Panel a widget can show; the server lists no others, and a newer kind is left out rather than drawn wrongly. */
val OFFERED_KINDS = setOf("items", "filter")

object Wire {
    val json = Json {
        ignoreUnknownKeys = true
        isLenient = false
    }
}
