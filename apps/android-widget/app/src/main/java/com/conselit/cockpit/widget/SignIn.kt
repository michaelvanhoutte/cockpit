package com.conselit.cockpit.widget

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/*
 * The parts of signing in that are only arithmetic and addresses: the PKCE pair,
 * the address the browser is sent to, and what comes back on the way home. The
 * conversation with the server is `CockpitClient`.
 */

object Pkce {
    private val urlSafe = Base64.getUrlEncoder().withoutPadding()

    /** A fresh secret only this install knows, kept until the code comes back. */
    fun verifier(random: SecureRandom = SecureRandom()): String =
        urlSafe.encodeToString(ByteArray(32).also(random::nextBytes))

    /** What the server is told in place of the verifier (S256). */
    fun challenge(verifier: String): String =
        urlSafe.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    /** An unguessable value that ties the way back to the way out. */
    fun state(random: SecureRandom = SecureRandom()): String =
        urlSafe.encodeToString(ByteArray(16).also(random::nextBytes))
}

object SignInAddress {
    private fun enc(value: String) = URLEncoder.encode(value, "UTF-8")

    /**
     * Where the browser is sent: the server's consent, asking for nothing but the
     * reads of Panels, which is the `{origin}/apps` resource. No scope: what a
     * token reaches is the resource it was made for.
     */
    fun authorize(origin: String, clientId: String, redirectUri: String, state: String, challenge: String): String {
        val root = origin.trimEnd('/')
        val query = listOf(
            "response_type" to "code",
            "client_id" to clientId,
            "redirect_uri" to redirectUri,
            "state" to state,
            "code_challenge" to challenge,
            "code_challenge_method" to "S256",
            "resource" to "$root/apps",
        ).joinToString("&") { (name, value) -> "$name=${enc(value)}" }
        return "$root/oauth/authorize?$query"
    }

    /** What the browser handed back on the private address. */
    sealed interface Back {
        data class Code(val code: String) : Back

        /** The person said no, or the server did; `error` is its word for it. */
        data class Refused(val error: String) : Back

        /** Not the answer to the sign-in this app started: another state, or another server. */
        data object Unexpected : Back
    }

    fun parseBack(address: String, expectedState: String, origin: String): Back {
        val rawQuery = try {
            URI(address).rawQuery
        } catch (e: java.net.URISyntaxException) {
            null
        }
        val query = rawQuery ?: return Back.Unexpected
        val params = query.split('&').filter { it.isNotEmpty() }.associate { pair ->
            val at = pair.indexOf('=')
            val name = if (at < 0) pair else pair.substring(0, at)
            val value = if (at < 0) "" else pair.substring(at + 1)
            URLDecoder.decode(name, "UTF-8") to URLDecoder.decode(value, "UTF-8")
        }
        if (params["state"] != expectedState) return Back.Unexpected
        // The server names itself on the way home (RFC 9207), so an answer from
        // another server cannot be taken for this one's.
        val issuer = params["iss"]
        if (issuer != null && issuer.trimEnd('/') != origin.trimEnd('/')) return Back.Unexpected
        val error = params["error"]
        if (error != null) return Back.Refused(error)
        val code = params["code"]
        return if (code.isNullOrEmpty()) Back.Unexpected else Back.Code(code)
    }
}
