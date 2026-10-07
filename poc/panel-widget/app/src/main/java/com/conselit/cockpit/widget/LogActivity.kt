package com.conselit.cockpit.widget

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView

/** The POC's only screen: how to place the widget, and every refresh it has recorded. */
class LogActivity : Activity() {
    override fun onResume() {
        super.onResume()
        val entries = RefreshLog.all(this).reversed()
        val text = buildString {
            appendLine("Long-press the home screen → Widgets → Cockpit widget (POC).")
            appendLine()
            appendLine("${entries.size} refreshes recorded, newest first:")
            entries.forEach { appendLine(RefreshLog.describe(it)) }
        }
        val view = TextView(this).apply {
            setPadding(48, 96, 48, 48)
            textSize = 14f
            setText(text)
        }
        setContentView(ScrollView(this).apply { addView(view) })
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }
}
