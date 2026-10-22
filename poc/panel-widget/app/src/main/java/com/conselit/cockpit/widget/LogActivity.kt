package com.conselit.cockpit.widget

import android.app.Activity
import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** The POC's only screen: how to place the widget, and every refresh it has recorded. */
class LogActivity : Activity() {
    override fun onResume() {
        super.onResume()
        val entries = RefreshLog.all(this).reversed()
        val text = buildString {
            appendLine("Cockpit widget (POC), build 2")
            appendLine()
            appendLine("Long-press the home screen → Widgets → Cockpit widget (POC).")
            appendLine()
            appendLine("${entries.size} refreshes recorded, newest first:")
            entries.forEach { appendLine(RefreshLog.describe(it)) }
        }
        val view = TextView(this).apply {
            textSize = 14f
            setText(text)
        }
        val scroll = ScrollView(this).apply { addView(view) }
        // Android 15 draws an app under the status and navigation bars, so pad by them.
        ViewCompat.setOnApplyWindowInsetsListener(scroll) { _, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(48, bars.top + 48, 48, bars.bottom + 48)
            insets
        }
        setContentView(scroll)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        actionBar?.hide()
    }
}
