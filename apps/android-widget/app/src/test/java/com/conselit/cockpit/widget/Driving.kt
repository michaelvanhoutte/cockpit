package com.conselit.cockpit.widget

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController

/** Every view of a given type under a root, depth first. */
fun View.everyView(): List<View> =
    if (this is ViewGroup) listOf<View>(this) + (0 until childCount).flatMap { getChildAt(it).everyView() } else listOf(this)

inline fun <reified T : View> View.all(): List<T> = everyView().filterIsInstance<T>()

fun Activity.button(label: String): Button =
    window.decorView.all<Button>().first { it.text.toString() == label }

fun Activity.texts(): List<String> = window.decorView.all<TextView>().map { it.text.toString() }

/**
 * A person signing in, as far as the app can see it: the screen sends the browser to
 * Cockpit, and the browser returns on the private address with a code. Everything
 * else (registering, the token, what the app does with it) is the app's own.
 */
class SigningIn(private val phone: Phone) {
    lateinit var screen: ActivityController<MainActivity>
        private set

    /** The address the browser was sent to. */
    lateinit var browserAddress: Uri
        private set

    /** Opens the app as a widget that is signed out does, and follows it to the browser. */
    fun fromAWidget(): SigningIn {
        screen = Robolectric.buildActivity(
            MainActivity::class.java,
            Intent(phone.context, MainActivity::class.java).setAction(MainActivity.ACTION_SIGN_IN),
        ).setup()
        browserAddress = shadowOf(screen.get()).nextStartedActivity.data!!
        return this
    }

    /** Opens the app on its own and presses Sign in. */
    fun fromTheApp(): SigningIn {
        screen = Robolectric.buildActivity(MainActivity::class.java).setup()
        screen.get().button("Sign in").performClick()
        browserAddress = shadowOf(screen.get()).nextStartedActivity.data!!
        return this
    }

    /** The browser comes home with the code. */
    fun comesHome(code: String = "the-code", state: String = browserAddress.getQueryParameter("state")!!) {
        screen.newIntent(
            Intent(Intent.ACTION_VIEW, Uri.parse("cockpit-widget://oauth?code=$code&state=$state&iss=${phone.cockpit.origin}")),
        )
    }
}