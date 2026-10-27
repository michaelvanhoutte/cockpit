package com.conselit.cockpit.widget

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDate

/**
 * Home-screen widget: a refresh shows the Panel as it is now, or says why it cannot.
 * The server only ever adds fields, so a field this version does not know must
 * change nothing it draws (A1, on the sample answer with one added everywhere).
 */
class UnknownFields {
    private val today = LocalDate.parse("2026-10-23")
    private val origin = "https://cockpit.example"

    /** The same answer with an unknown field in every object. */
    private fun withExtraFields(element: JsonElement): JsonElement = when (element) {
        is JsonObject -> JsonObject(element.mapValues { withExtraFields(it.value) } + ("addedLater" to JsonPrimitive("ignored")))
        is JsonArray -> JsonArray(element.map(::withExtraFields))
        else -> element
    }

    @Test
    fun `a field it does not know draws as before`() {
        for (sample in listOf(Samples.flatPanel, Samples.groupedFilterPanel)) {
            val plain = Wire.json.decodeFromString<PanelRead>(sample)
            val extended = Wire.json.decodeFromString<PanelRead>(
                Wire.json.encodeToString(JsonElement.serializer(), withExtraFields(Wire.json.parseToJsonElement(sample))),
            )
            assertEquals(linesOf(plain, origin, today), linesOf(extended, origin, today))
        }
        val list = Wire.json.decodeFromString<PanelList>(Samples.panelList)
        val extendedList = Wire.json.decodeFromString<PanelList>(
            Wire.json.encodeToString(JsonElement.serializer(), withExtraFields(Wire.json.parseToJsonElement(Samples.panelList))),
        )
        assertEquals(pickerEntries(list), pickerEntries(extendedList))
    }
}