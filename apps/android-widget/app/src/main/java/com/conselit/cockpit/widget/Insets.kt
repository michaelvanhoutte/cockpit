package com.conselit.cockpit.widget

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Keeps this screen's content clear of the status bar, the navigation bar and the
 * cut-out. From Android 15 every app is drawn edge to edge, so a screen that does
 * nothing puts its first lines under the status bar; on older Androids the system
 * already insets the window and these insets arrive as zero.
 *
 * The padding the view was built with is kept and the bars are added to it, so it
 * can be applied once and survives the insets changing (a turned phone, a keyboard).
 */
fun View.keepClearOfSystemBars() {
    val left = paddingLeft
    val top = paddingTop
    val right = paddingRight
    val bottom = paddingBottom
    ViewCompat.setOnApplyWindowInsetsListener(this) { view, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        view.setPadding(left + bars.left, top + bars.top, right + bars.right, bottom + bars.bottom)
        // Taken here: the children are laid out inside this padding, and must not add it again.
        WindowInsetsCompat.CONSUMED
    }
}
