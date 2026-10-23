package com.conselit.cockpit.widget

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.browser.customtabs.CustomTabsIntent

/**
 * The app's one screen, and the address the browser returns to after Cockpit's
 * sign-in and consent. It says whether the phone is signed in and offers to do
 * either, and otherwise stays out of the way: the widget is the product.
 *
 * Opened from a widget that is signed out, it signs in and then closes itself, so
 * the person lands back where they were.
 */
class MainActivity : Activity() {
    private val graph get() = application.graph
    private lateinit var status: TextView
    private lateinit var action: Button
    private lateinit var secondary: Button
    private var note: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            val pad = (24 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad * 2, pad, pad)
        }
        status = TextView(this).apply { textSize = 18f }
        action = Button(this)
        secondary = Button(this)
        column.addView(status)
        column.addView(action)
        column.addView(secondary)
        setContentView(column)
        // A turned screen is built again with the same intent, which must not begin a second sign-in.
        if (savedInstanceState == null) handle(intent) else show()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent) {
        val data = intent.data
        when {
            data != null && data.scheme == Uri.parse(graph.redirectUri).scheme -> finishSignIn(data)
            intent.action == ACTION_SIGN_IN && !graph.session.isSignedIn() -> beginSignIn(closeWhenDone = true)
            else -> show()
        }
    }

    private fun show() {
        val signedIn = graph.session.isSignedIn()
        status.text = note ?: if (signedIn) {
            "Signed in. Add a Cockpit widget from your home screen's widget list, then pick a Panel."
        } else {
            "Sign in to Cockpit so your widgets can show your Panels."
        }
        note = null
        if (signedIn) {
            action.visibility = android.view.View.GONE
            secondary.text = "Sign out on this phone"
            secondary.visibility = android.view.View.VISIBLE
            secondary.setOnClickListener {
                graph.signOut()
                graph.renderer.drawAll(refreshing = false)
                show()
            }
        } else {
            secondary.visibility = android.view.View.GONE
            action.visibility = android.view.View.VISIBLE
            action.text = "Sign in"
            action.setOnClickListener { beginSignIn(closeWhenDone = false) }
        }
    }

    /** Registers this install once, then sends the browser to Cockpit's consent. */
    private fun beginSignIn(closeWhenDone: Boolean) {
        graph.io.execute {
            val clientId = graph.client.clientId()
            runOnUiThread {
                if (clientId == null) {
                    note = "Could not reach Cockpit. Check the connection and try again."
                    show()
                } else {
                    val verifier = Pkce.verifier()
                    val state = Pkce.state()
                    if (!graph.session.savePending(Pending(state, verifier, closeWhenDone))) {
                        note = "This phone could not keep a sign-in safe, so the widget cannot sign in."
                        show()
                        return@runOnUiThread
                    }
                    val address = SignInAddress.authorize(
                        graph.origin, clientId, graph.redirectUri, state, Pkce.challenge(verifier),
                    )
                    CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(address))
                }
            }
        }
    }

    private fun finishSignIn(back: Uri) {
        val pending = graph.session.pending()
        if (pending == null) {
            show()
            return
        }
        val result = SignInAddress.parseBack(back.toString(), pending.state, graph.origin)
        // Only the answer to this sign-in spends it; anything else leaves it for the real one.
        if (result != SignInAddress.Back.Unexpected) graph.session.finishPending()
        when (result) {
            is SignInAddress.Back.Code -> graph.io.execute {
                val outcome = graph.client.signIn(result.code, pending.verifier)
                runOnUiThread { signedIn(outcome, pending) }
            }
            is SignInAddress.Back.Refused -> {
                note = "Cockpit did not allow it (${result.error}). Sign in to try again."
                show()
            }
            SignInAddress.Back.Unexpected -> {
                note = "That was not the answer to this sign-in. Sign in to try again."
                show()
            }
        }
    }

    private fun signedIn(outcome: SignedIn, pending: Pending) {
        if (outcome != SignedIn.Yes) {
            note = if (outcome == SignedIn.Offline) {
                "Could not reach Cockpit. Check the connection and sign in again."
            } else {
                "Signing in did not finish. Sign in to try again."
            }
            show()
            return
        }
        // Every widget that was waiting to be signed in reads at once.
        graph.renderer.drawAll(refreshing = true)
        graph.background.refreshNow()
        if (graph.renderer.liveWidgetIds().isNotEmpty()) graph.background.schedule()
        askAboutBattery { if (pending.closeWhenDone) finish() else show() }
    }

    /**
     * The one-off step after the first sign-in: say why, then open Android's own
     * dialog. Put once, whatever the answer; declining leaves the widget working,
     * refreshed when Android allows. Not put at all where the phone already exempts the app.
     */
    private fun askAboutBattery(then: () -> Unit) {
        val exempt = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        if (exempt || graph.session.batteryStepAsked()) {
            then()
            return
        }
        // Left, or turned, while the sign-in was being traded: nothing to put a dialog on.
        if (isFinishing || isDestroyed) return
        graph.session.markBatteryStepAsked()
        AlertDialog.Builder(this)
            .setTitle("Keep your Panels fresh")
            .setMessage(
                "Without this, Android may leave the list hours old while your phone sits idle. " +
                    "On the next screen, allow Cockpit widget to keep running in the background.",
            )
            .setPositiveButton("Continue") { _, _ ->
                startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")),
                )
                then()
            }
            .setNegativeButton("Not now") { _, _ -> then() }
            .setOnCancelListener { then() }
            .show()
    }

    companion object {
        /** Sent by a widget that is signed out; signs in and closes. */
        const val ACTION_SIGN_IN = "com.conselit.cockpit.widget.SIGN_IN"
    }
}
