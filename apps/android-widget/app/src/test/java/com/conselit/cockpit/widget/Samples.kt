package com.conselit.cockpit.widget

import java.io.File

/**
 * The sample answers the server's own tests hold its real answers to
 * (`packages/shared/samples/`), read from the repository and never copied: when the
 * server changes an answer, these are what the app is proved against.
 */
object Samples {
    private val directory = File(System.getProperty("cockpit.samples") ?: error("cockpit.samples is not set"))

    fun text(name: String): String = File(directory, name).readText()

    /** A Panel of items. */
    val flatPanel get() = text("panel-read-flat.sample.json")

    /** A Filter panel grouped by Panel. */
    val groupedFilterPanel get() = text("panel-read.sample.json")

    val panelList get() = text("panel-list.sample.json")
}